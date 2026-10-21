#!/usr/bin/env node
import { createRequire } from "node:module";
import { parseArgs } from "node:util";
import { buildBaseline, diffBaseline, loadBaseline, saveBaseline } from "./baseline.js";
import { runBuild } from "./build.js";
import { loadConfig } from "./config.js";
import { discoverRoutes, findProjectRoot } from "./discover.js";
import { probeRoutes } from "./probe.js";
import { renderReport } from "./report.js";
import { startDevServer } from "./server.js";
import type { Finding } from "./types.js";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };

const USAGE = `꼼꼼 — Next.js 커밋 전 점검

사용법
  kkomkkom               인증 검사 + 빌드/무게 검사
  kkomkkom --fast        인증 검사만 (빌드 생략)
  kkomkkom --json        기계가 읽는 JSON 출력
  kkomkkom --update      --fast 결과를 기준선에 반영 (전체 실행은 자동 저장)
  kkomkkom --port 3100   개발 서버 포트 지정

설정
  kkomkkom.config.json 을 프로젝트 루트에 두면 동작을 바꿀 수 있습니다.
`;

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      fast: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      update: { type: "boolean", default: false },
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
  const config = await loadConfig(root);
  const port = values.port ? Number(values.port) : config.port;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error("포트 번호가 올바르지 않습니다.");

  const routes = await discoverRoutes(root);
  if (routes.length === 0) throw new Error("검사할 라우트를 찾지 못했습니다. app/ 또는 pages/ 폴더를 확인해주세요.");

  const server = await startDevServer(root, port);
  let findings: Finding[];
  try {
    findings = await probeRoutes(server.url, routes, config);
  } finally {
    await server.stop();
  }

  let pages: Record<string, { firstLoadJs: number }> = {};
  let buildFailed = false;
  let buildTail = "";
  if (!values.fast) {
    const build = await runBuild(root);
    pages = build.pages;
    if (!build.ok) {
      buildFailed = true;
      buildTail = build.output;
    }
  }

  const previous = await loadBaseline(root);
  const effectivePages = values.fast && previous ? previous.pages : pages;
  const diff = diffBaseline(previous, findings, effectivePages, config.thresholds);

  if (!values.fast && !buildFailed) {
    await saveBaseline(root, buildBaseline(findings, pages));
  } else if (values.fast && values.update && previous) {
    await saveBaseline(root, buildBaseline(findings, previous.pages));
  }

  if (values.json) {
    console.log(JSON.stringify({ diff, buildFailed }, null, 2));
  } else {
    console.log(
      renderReport(diff, {
        color: Boolean(process.stdout.isTTY) && !process.env.NO_COLOR,
        buildFailed,
        buildTail,
      }),
    );
  }

  const exposed = diff.routes.filter((route) => route.to === "exposed").length;
  return buildFailed || exposed > 0 ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(`꼼꼼: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  });
