#!/usr/bin/env node
import { createRequire } from "node:module";
import { parseArgs } from "node:util";
import { findProjectRoot } from "./discover.js";
import { KkomkkomError } from "./errors.js";
import { buildPrompt, explain } from "./explain.js";
import { isLang, resolveLang, t, type Lang } from "./i18n.js";
import { renderReport } from "./report.js";
import { runArtifactCheck } from "./artifacts.js";
import { runCheck } from "./run.js";
import { severityOf } from "./severity.js";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };

const USAGE = `kkomkkom — pre-commit check for Next.js

Usage
  kkomkkom                    check auth, secrets, pages + page weight
  kkomkkom --fast             skip the build (page weights are not measured)
  kkomkkom --artifacts        inspect public/.next/static without a server or build
  kkomkkom --artifacts --fresh
                               build first, then inspect the new output
  kkomkkom --artifacts --production-url http://127.0.0.1:3000
                                opt in to GET-only local serving verification
  kkomkkom --protect-sourcemaps
                                preview a literal source-map setting change only
  kkomkkom --protect-sourcemaps --apply --expected-hash HASH
                                explicitly apply, build and verify owned production
  kkomkkom --restore TRANSACTION_ID
                                restore config only if applied bytes still match
  kkomkkom --json             inspection JSON (schemaVersion 2), or protection action result
  kkomkkom --explain          explain problems with a local AI CLI
  kkomkkom --explain-with claude
  kkomkkom --update           save a complete check as the baseline
  kkomkkom --port 3100        dev server port (default: config port or 3100)
  kkomkkom --reuse            use a Next server already running on the port
                              (its project identity is not verified)
  kkomkkom --lang ko          report language: en, ko, ja, zh, es
  kkomkkom --strict           exit 1 on warnings or incomplete coverage

Exit codes
  0  nothing blocking
  1  deploy-blocking problem (open API, exposed secret, build failure, or any warning/incompleteness with --strict)
  2  the check could not run or the update was refused (project, port, config, baseline)

Config
  kkomkkom.config.json in the project root changes behavior.
  The baseline is written only by --update, never by a normal check.

꼼꼼 — Next.js 커밋 전 점검
  kkomkkom                    API 인증·비밀키·페이지 오류·페이지 무게 검사
  kkomkkom --fast             빌드 생략 (페이지 무게는 측정하지 않음)
  kkomkkom --artifacts        서버·빌드 없이 public/.next/static 배포물 검사
  kkomkkom --artifacts --fresh
                               먼저 빌드한 뒤 새 배포물 검사
  kkomkkom --artifacts --production-url http://127.0.0.1:3000
                                명시한 로컬 서버에 GET으로 실제 제공 여부 확인
  kkomkkom --protect-sourcemaps
                                소스맵 설정 token 변경 미리보기만 실행
  kkomkkom --protect-sourcemaps --apply --expected-hash HASH
                                명시 적용 후 production 빌드·소유 서버 검증
  kkomkkom --restore TRANSACTION_ID
                                hash가 일치하는 설정만 원본으로 복원
  kkomkkom --json             일반 검사 JSON(schemaVersion 2) 또는 보호 작업 결과
  kkomkkom --explain          문제 원인을 로컬 AI CLI로 설명
  kkomkkom --update           완료된 검사 결과를 기준선으로 저장
  kkomkkom --port 3100        개발 서버 포트 (기본: 설정값 또는 3100)
  kkomkkom --reuse            이미 실행 중인 Next 서버 재사용
                              (해당 프로젝트인지 확인하지 않음)
  kkomkkom --lang ko          보고서 언어: en, ko, ja, zh, es
  kkomkkom --strict           경고 또는 불완전한 검사도 종료 코드 1

  종료 코드: 0 문제 없음 / 1 배포를 막는 문제(API 노출·비밀키 노출·빌드 실패·--strict 경고/불완전) / 2 검사를 시작·완료하지 못함(프로젝트·포트·설정·기준선 오류 또는 갱신 거부)
  기준선은 --update로만 저장합니다. 일반 검사는 기준선을 쓰지 않습니다.
`;

let activeLang: Lang = resolveLang();

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      fast: { type: "boolean", default: false },
      artifacts: { type: "boolean", default: false },
      fresh: { type: "boolean", default: false },
      "production-url": { type: "string" },
      "protect-sourcemaps": { type: "boolean", default: false },
      apply: { type: "boolean", default: false },
      "expected-hash": { type: "string" },
      restore: { type: "string" },
      json: { type: "boolean", default: false },
      update: { type: "boolean", default: false },
      strict: { type: "boolean", default: false },
      reuse: { type: "boolean", default: false },
      explain: { type: "boolean", default: false },
      "explain-with": { type: "string" },
      lang: { type: "string" },
      port: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "v", default: false },
    },
  });

  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  if (values.version) {
    console.log(pkg.version);
    return 0;
  }

  const flagged = values.lang?.toLowerCase().split(/[._-]/)[0];
  if (flagged && !isLang(flagged)) {
    throw new KkomkkomError("errLang", { lang: values.lang ?? "" });
  }
  const lang = resolveLang(values.lang);
  activeLang = lang;

  const protecting = values["protect-sourcemaps"] || values.apply || values["expected-hash"] !== undefined || values.restore !== undefined;
  if (protecting) {
    const restoring = values.restore !== undefined;
    if ((restoring && (values["protect-sourcemaps"] || values.apply || values["expected-hash"] !== undefined ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(values.restore!))) ||
        (!restoring && (!values["protect-sourcemaps"] || values.apply !== (values["expected-hash"] !== undefined) ||
        (values.apply && !/^[a-f0-9]{64}$/.test(values["expected-hash"]!)))) ||
        values.artifacts || values.fast || values.fresh || values.update || values.strict || values.reuse || values.explain ||
        values["production-url"] !== undefined || values["explain-with"] !== undefined || values.port !== undefined) {
      throw new KkomkkomError("errProtectArgs");
    }
    const { applyAndVerifyProtection, previewProtection, ProtectionError, restoreProtection } = await import("./protect.js");
    const root = await findProjectRoot(process.cwd());
    try {
      const result = restoring
        ? await restoreProtection(root, values.restore!)
        : values.apply
          ? await applyAndVerifyProtection(root, values["expected-hash"]!)
          : await previewProtection(root).then((preview) => ({ ...preview, exitCode: preview.status === "unsupported" ? 2 : 0 }));
      const transactionId = "transactionId" in result ? result.transactionId : "<TRANSACTION_ID>";
      const expectedHash = "expectedHash" in result ? result.expectedHash : undefined;
      const payload = { ...result, lang,
        ...(expectedHash ? { applyCommand: `kkomkkom --protect-sourcemaps --apply --expected-hash ${expectedHash}` } : {}),
        restoreCommand: `kkomkkom --restore ${transactionId}`,
        notes: [t(lang, "protectImpact"), t(lang, "protectSideEffects"), t(lang, "protectRestore")],
      };
      if (values.json) console.log(JSON.stringify(payload, null, 2));
      else {
        console.log(`protection: ${result.status}`);
        if ("diff" in result && result.diff) console.log(`${result.file}:${result.diff.line}:${result.diff.column}\n- true\n+ false`);
        if (expectedHash) console.log(`expected hash: ${expectedHash}\nkkomkkom --protect-sourcemaps --apply --expected-hash ${expectedHash}`);
        if ("verification" in result) console.log(`verification: ${JSON.stringify(result.verification)}\nrollback: ${result.rollback}`);
        if ("rollbackFailureReason" in result && result.rollbackFailureReason) console.log(`rollback detail: ${result.rollbackFailureReason}`);
        if ("lockCleanup" in result) console.log(`lock cleanup: ${result.lockCleanup}${result.lockCleanupFailureReason ? ` (${result.lockCleanupFailureReason})` : ""}`);
        console.log(payload.notes.join("\n"));
        console.log(payload.restoreCommand);
      }
      return result.exitCode;
    } catch (error) {
      throw new KkomkkomError("errProtectRun", {
        reason: error instanceof ProtectionError ? `${error.configRestored ? "config-restored/" : ""}${error.reason}${error.lockCleanup ? `; lock cleanup: ${error.lockCleanup}${error.lockCleanupFailureReason ? ` (${error.lockCleanupFailureReason})` : ""}` : ""}${error.transactionId ? `; kkomkkom --restore ${error.transactionId}` : ""}` : "unsafe-or-unreadable-state",
        changed: error instanceof ProtectionError && error.configChanged ? "yes" : "no",
      });
    }
  }

  if (values.fresh && !values.artifacts) {
    throw new KkomkkomError("errModeConflict", { option: "--fresh" });
  }
  if (values["production-url"] !== undefined && !values.artifacts) {
    throw new KkomkkomError("errProductionUrl");
  }
  if (values.artifacts) {
    for (const [option, present] of [
      ["--fast", values.fast],
      ["--update", values.update],
      ["--reuse", values.reuse],
      ["--explain", values.explain],
      ["--explain-with", values["explain-with"] !== undefined],
      ["--port", values.port !== undefined],
    ] as const) {
      if (present) throw new KkomkkomError("errModeConflict", { option });
    }
  }

  const root = await findProjectRoot(process.cwd());
  const port = values.port ? Number(values.port) : undefined;
  if (values.port && (!Number.isInteger(port) || port! <= 0 || port! > 65535)) {
    throw new KkomkkomError("errPort");
  }

  const result = values.artifacts
    ? await runArtifactCheck({
      root,
      fresh: values.fresh,
      strict: values.strict,
      productionUrl: values["production-url"],
    })
    : await runCheck({
      root,
      fast: values.fast,
      update: values.update,
      port,
      strict: values.strict,
      reuse: values.reuse,
    });

  const hasIssues =
    result.diff.routes.some(
      (route) => route.to === "exposed" || route.to === "check" || route.to === "error",
    ) || result.diff.pages.some((page) => page.heavy) || result.extras.length > 0;
  const shouldExplain = values.explain && hasIssues;

  let explanation: { provider: string; text: string } | null = null;
  let prompt = "";
  if (shouldExplain) {
    explanation = await explain(result.diff, {
      prefer: values["explain-with"],
      lang,
      extras: result.extras,
    });
    if (!explanation) prompt = buildPrompt(result.diff, lang, result.extras);
  }

  if (values.json) {
    const payload = {
      schemaVersion: result.schemaVersion,
      lang,
      exitCode: result.exitCode,
      buildFailed: result.buildFailed,
      coverage: result.coverage,
      diff: {
        ...result.diff,
        routes: result.diff.routes.map((route) => ({
          ...route,
          severity: severityOf(route.to),
          detail: t(lang, route.detailKey, route.detailVars),
        })),
      },
      extra: result.extras.map((extra) => ({
        id: extra.id,
        severity: extra.severity,
        message: t(lang, extra.messageKey, extra.messageVars),
        ...(extra.rule ? { rule: extra.rule } : {}),
        ...(extra.file ? { file: extra.file } : {}),
        ...(extra.evidenceKind ? { evidenceKind: extra.evidenceKind } : {}),
        ...(extra.confidence ? { confidence: extra.confidence } : {}),
        ...(extra.evidence ? { evidence: extra.evidence } : {}),
      })),
      explanation,
    };
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log(
      renderReport(result.diff, {
        lang,
        color: Boolean(process.stdout.isTTY) && !process.env.NO_COLOR,
        buildFailed: result.buildFailed,
        buildTail: result.buildTail,
        extras: result.extras,
        coverage: result.coverage,
      }),
    );

    if (explanation) {
      console.log("");
      console.log(t(lang, "explainHeader", { provider: explanation.provider }));
      console.log(explanation.text);
    } else if (prompt) {
      console.log("");
      console.log(t(lang, "promptHeader"));
      console.log("");
      console.log(prompt);
    }
  }

  return result.exitCode;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    if (error instanceof KkomkkomError) {
      console.error(`kkomkkom: ${t(activeLang, error.key, error.vars)}`);
    } else {
      console.error(`kkomkkom: ${error instanceof Error ? error.message : String(error)}`);
    }
    process.exit(2);
  });
