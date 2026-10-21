import { runBuild } from "./build.js";
import { buildBaseline, diffBaseline, loadBaseline, saveBaseline } from "./baseline.js";
import { loadConfig } from "./config.js";
import { discoverRoutes } from "./discover.js";
import { probeRoutes } from "./probe.js";
import { startDevServer } from "./server.js";
import type { Diff } from "./types.js";

export interface RunOptions {
  root: string;
  fast: boolean;
  update?: boolean;
  port?: number;
}

export interface RunResult {
  diff: Diff;
  buildFailed: boolean;
  buildTail: string;
  exitCode: number;
}

export async function runCheck(options: RunOptions): Promise<RunResult> {
  const config = await loadConfig(options.root);
  const port = options.port ?? config.port;

  const routes = await discoverRoutes(options.root);
  if (routes.length === 0) {
    throw new Error("검사할 라우트를 찾지 못했습니다. app/ 또는 pages/ 폴더를 확인해주세요.");
  }

  const server = await startDevServer(options.root, port);
  let findings;
  try {
    findings = await probeRoutes(server.url, routes, config);
  } finally {
    await server.stop();
  }

  let pages: Record<string, { firstLoadJs: number }> = {};
  let buildFailed = false;
  let buildTail = "";
  if (!options.fast) {
    const build = await runBuild(options.root);
    pages = build.pages;
    if (!build.ok) {
      buildFailed = true;
      buildTail = build.output;
    }
  }

  const previous = await loadBaseline(options.root);
  const effectivePages = options.fast && previous ? previous.pages : pages;
  const diff = diffBaseline(previous, findings, effectivePages, config.thresholds);

  if (!options.fast && !buildFailed) {
    await saveBaseline(options.root, buildBaseline(findings, pages));
  } else if (options.fast && options.update && previous) {
    await saveBaseline(options.root, buildBaseline(findings, previous.pages));
  }

  const exposed = diff.routes.filter((route) => route.to === "exposed").length;
  return { diff, buildFailed, buildTail, exitCode: buildFailed || exposed > 0 ? 1 : 0 };
}
