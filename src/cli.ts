#!/usr/bin/env node
import { createRequire } from "node:module";
import { parseArgs } from "node:util";
import { findProjectRoot } from "./discover.js";
import { KkomkkomError } from "./errors.js";
import { buildPrompt, explain } from "./explain.js";
import { isLang, resolveLang, t, type Lang } from "./i18n.js";
import { renderReport } from "./report.js";
import { runCheck } from "./run.js";
import { severityOf } from "./severity.js";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };

const USAGE = `kkomkkom — pre-commit check for Next.js

Usage
  kkomkkom                    check auth, secrets, pages + page weight
  kkomkkom --fast             skip the build (all checks still run)
  kkomkkom --json             machine-readable JSON
  kkomkkom --explain          explain problems with a local AI CLI
  kkomkkom --explain-with claude
  kkomkkom --update           save a --fast result as the baseline
  kkomkkom --port 3100        dev server port
  kkomkkom --reuse            use a Next server already running on the port
  kkomkkom --lang ko          report language: en, ko, ja, zh, es
  kkomkkom --strict           exit 1 on warnings too

Exit codes
  0  nothing blocking
  1  deploy-blocking problem (open API, exposed secret, build failure, or any warning with --strict)
  2  the check could not run (project, port, or config error)

Config
  kkomkkom.config.json in the project root changes behavior.

꼼꼼 — Next.js 커밋 전 점검
  kkomkkom                    API 인증·비밀키·페이지 오류·페이지 무게 검사
  kkomkkom --fast             빌드만 생략 (나머지 검사는 모두 실행)
  kkomkkom --json             기계가 읽는 JSON 출력
  kkomkkom --explain          문제 원인을 로컬 AI CLI로 설명
  kkomkkom --update           --fast 결과를 기준선에 반영
  kkomkkom --port 3100        개발 서버 포트 지정
  kkomkkom --reuse            이미 실행 중인 Next 서버 재사용 (프로젝트 확인 안 함)
  kkomkkom --lang ko          보고서 언어: en, ko, ja, zh, es
  kkomkkom --strict           경고만 있어도 종료 코드 1

  종료 코드: 0 문제 없음 / 1 배포를 막는 문제(API 노출·비밀키 노출·빌드 실패·--strict 경고) / 2 검사를 시작·완료하지 못함(프로젝트·포트·설정 오류)
`;

let activeLang: Lang = resolveLang();

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      fast: { type: "boolean", default: false },
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

  const root = await findProjectRoot(process.cwd());
  const port = values.port ? Number(values.port) : undefined;
  if (values.port && (!Number.isInteger(port) || port! <= 0 || port! > 65535)) {
    throw new KkomkkomError("errPort");
  }

  const result = await runCheck({
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
      lang,
      exitCode: result.exitCode,
      buildFailed: result.buildFailed,
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
