import { auditProject } from "./audit.js";
import { runBuild } from "./build.js";
import { buildBaseline, diffBaseline, loadBaseline, saveBaseline } from "./baseline.js";
import { loadConfig } from "./config.js";
import { discoverRoutes } from "./discover.js";
import { probeRoutes } from "./probe.js";
import { startDevServer } from "./server.js";
import { KkomkkomError } from "./errors.js";
import type { Diff, ExtraFinding, Finding } from "./types.js";

export interface RunOptions {
  root: string;
  fast: boolean;
  update?: boolean;
  port?: number;
  strict?: boolean;
  reuse?: boolean;
}

export interface RunResult {
  diff: Diff;
  extras: ExtraFinding[];
  buildFailed: boolean;
  buildTail: string;
  exitCode: number;
}

export async function runCheck(options: RunOptions): Promise<RunResult> {
  const config = await loadConfig(options.root);
  const port = options.port ?? config.port;

  const routes = await discoverRoutes(options.root);
  if (routes.length === 0) {
    throw new KkomkkomError("errNoRoutes");
  }

  const server = await startDevServer(options.root, port, { reuse: options.reuse });
  let findings: Finding[];
  let extras: ExtraFinding[] = [];
  try {
    findings = await probeRoutes(server.url, routes, config);
    extras = await auditProject({
      root: options.root,
      baseUrl: server.url,
      routes,
      config,
    });
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
  } else if (options.fast && options.update) {
    await saveBaseline(options.root, buildBaseline(findings, previous?.pages ?? {}));
  }

  const exposed = diff.routes.filter((route) => route.to === "exposed").length;
  const criticalExtras = extras.filter((extra) => extra.severity === "critical").length;
  const warnings =
    diff.routes.filter((route) => route.to === "check" || route.to === "error").length +
    diff.pages.filter((page) => page.heavy).length +
    extras.filter((extra) => extra.severity === "warning").length;
  const exitCode =
    buildFailed || exposed > 0 || criticalExtras > 0 || (options.strict === true && warnings > 0)
      ? 1
      : 0;
  return { diff, extras, buildFailed, buildTail, exitCode };
}
