#!/usr/bin/env node
import { createRequire } from "node:module";
import { parseArgs } from "node:util";
import { findProjectRoot } from "./discover.js";
import { explain, buildPrompt } from "./explain.js";
import { renderReport } from "./report.js";
import { runCheck } from "./run.js";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };

const USAGE = `꼼꼼 — Next.js 커밋 전 점검

사용법
  kkomkkom                    인증 검사 + 빌드/무게 검사
  kkomkkom --fast             인증 검사만 (빌드 생략)
  kkomkkom --json             기계가 읽는 JSON 출력
  kkomkkom --explain          실패 원인을 로컬 AI CLI로 설명
  kkomkkom --explain-with claude
  kkomkkom --update           --fast 결과를 기준선에 반영
  kkomkkom --port 3100        개발 서버 포트 지정

설정
  kkomkkom.config.json 을 프로젝트 루트에 두면 동작을 바꿀 수 있습니다.
`;

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      fast: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      update: { type: "boolean", default: false },
      explain: { type: "boolean", default: false },
      "explain-with": { type: "string" },
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

  const root = await findProjectRoot(process.cwd());
  const port = values.port ? Number(values.port) : undefined;
  if (values.port && (!Number.isInteger(port) || port! <= 0 || port! > 65535)) {
    throw new Error("포트 번호가 올바르지 않습니다.");
  }

  const result = await runCheck({ root, fast: values.fast, update: values.update, port });
  const hasIssues =
    result.diff.routes.some((route) => route.to === "exposed" || route.to === "error") ||
    result.diff.pages.some((page) => page.heavy);
  const shouldExplain = values.explain && hasIssues;

  let explanation: { provider: string; text: string } | null = null;
  let prompt = "";
  if (shouldExplain) {
    explanation = await explain(result.diff, { prefer: values["explain-with"] });
    if (!explanation) prompt = buildPrompt(result.diff);
  }

  if (values.json) {
    console.log(JSON.stringify({ diff: result.diff, buildFailed: result.buildFailed, explanation }, null, 2));
  } else {
    console.log(
      renderReport(result.diff, {
        color: Boolean(process.stdout.isTTY) && !process.env.NO_COLOR,
        buildFailed: result.buildFailed,
        buildTail: result.buildTail,
      }),
    );

    if (explanation) {
      console.log("");
      console.log(`💡 원인 추정 (${explanation.provider})`);
      console.log(explanation.text);
    } else if (prompt) {
      console.log("");
      console.log("💡 원인 설명을 받으려면 아래 글을 AI 채팅에 붙여넣으세요.");
      console.log("");
      console.log(prompt);
    }
  }

  return result.exitCode;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(`꼼꼼: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  });
