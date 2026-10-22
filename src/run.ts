import { auditProject, redactSecrets } from "./audit.js";
import { runBuild } from "./build.js";
import { buildBaseline, diffBaseline, loadBaseline, saveBaseline } from "./baseline.js";
import { loadConfig } from "./config.js";
import { discoverRoutes } from "./discover.js";
import { probeRoutes } from "./probe.js";
import { startDevServer } from "./server.js";
import { KkomkkomError } from "./errors.js";
import type {
  CoverageCheck, CoverageState, CoverageSummary, Diff, ExtraFinding, Finding,
} from "./types.js";

export interface RunOptions {
  root: string;
  fast: boolean;
  update?: boolean;
  port?: number;
  strict?: boolean;
  reuse?: boolean;
}

export interface RunResult {
  schemaVersion: 2;
  diff: Diff;
  extras: ExtraFinding[];
  coverage: CoverageSummary;
  buildFailed: boolean;
  buildTail: string;
  exitCode: number;
}

const COVERAGE_STATES: CoverageState[] = [
  "checked", "static-only", "ignored", "skipped", "failed", "unsupported",
];

export function summarizeCoverage(checks: CoverageCheck[]): CoverageSummary {
  const counts = Object.fromEntries(COVERAGE_STATES.map((state) => [state, 0])) as Record<
    CoverageState, number
  >;
  for (const check of checks) counts[check.status] += 1;

  // Secrets and build are not route coverage; route checks decide empty.
  const routeChecks = checks.filter((check) => check.rule !== "secrets" && check.rule !== "build");
  const completed = routeChecks.filter(
    (check) => check.status === "checked" || check.status === "static-only",
  ).length;
  const attempted = completed + routeChecks.filter(
    (check) => check.status === "failed" || check.status === "unsupported",
  ).length;

  const status: CoverageSummary["status"] = attempted === 0
    ? "empty"
    : counts.ignored + counts.skipped + counts.failed + counts.unsupported > 0
      ? "incomplete"
      : "complete";
  return { status, checks, counts };
}

export async function runCheck(options: RunOptions): Promise<RunResult> {
  const config = await loadConfig(options.root);
  const port = options.port ?? config.port;

  const routes = await discoverRoutes(options.root);
  if (routes.length === 0) {
    throw new KkomkkomError("errNoRoutes");
  }

  const server = await startDevServer(options.root, port, { reuse: options.reuse });
  const coverage: CoverageCheck[] = [];
  let findings: Finding[];
  let extras: ExtraFinding[] = [];
  try {
    findings = await probeRoutes(server.url, routes, config, coverage);
    extras = await auditProject({
      root: options.root,
      baseUrl: server.url,
      routes,
      config,
    }, coverage);
  } finally {
    await server.stop();
  }

  let pages: Record<string, { firstLoadJs: number }> = {};
  let buildFailed = false;
  let buildTail = "";
  if (options.fast) {
    coverage.push({ rule: "build", status: "skipped", reason: "fast" });
  } else {
    const build = await runBuild(options.root);
    pages = build.pages;
    if (!build.ok) {
      if (build.failure === undefined || build.failure === "compile") {
        buildFailed = true;
        coverage.push({ rule: "build", status: "failed", reason: "compile" });
        buildTail = await redactSecrets(options.root, build.output).catch(() => "");
      } else {
        const buildTail = await redactSecrets(options.root, build.output).catch(() => "");
        throw new KkomkkomError("errBuildRun", { reason: build.failure, log: buildTail });
      }
    } else {
      coverage.push({ rule: "build", status: "checked", reason: "build" });
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

  const summary = summarizeCoverage(coverage);
  const exposed = diff.routes.filter((route) => route.to === "exposed").length;
  const criticalExtras = extras.filter((extra) => extra.severity === "critical").length;
  const warnings =
    diff.routes.filter((route) => route.to === "check" || route.to === "error").length +
    diff.pages.filter((page) => page.heavy).length +
    extras.filter((extra) => extra.severity === "warning").length;
  const exitCode =
    buildFailed || exposed > 0 || criticalExtras > 0 ||
    (options.strict === true && (warnings > 0 || summary.status !== "complete"))
      ? 1
      : 0;
  return { schemaVersion: 2, diff, extras, coverage: summary, buildFailed, buildTail, exitCode };
}
