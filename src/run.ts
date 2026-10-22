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
  // Ignored and skipped are deliberate scope choices (ignoreRoutes, --fast,
  // a statically GET-less route). Missing evidence is failed/unsupported and
  // counts from every rule once the route scope itself is meaningful.
  const routeChecks = checks.filter((check) => check.rule !== "secrets" && check.rule !== "build");
  const attempted = routeChecks.filter(
    (check) => check.status !== "ignored" && check.status !== "skipped",
  ).length;
  const problems = checks.filter(
    (check) => check.status === "failed" || check.status === "unsupported",
  ).length;

  const status: CoverageSummary["status"] = attempted === 0
    ? "empty"
    : problems > 0
      ? "incomplete"
      : "complete";
  return { status, checks, counts };
}

export async function runCheck(options: RunOptions): Promise<RunResult> {
  const config = await loadConfig(options.root);
  const port = options.port ?? config.port;
  // A damaged baseline is a tool error before any server or build side effect.
  const previous = await loadBaseline(options.root);

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
  let measurementFailed = false;
  let buildTail = "";
  if (options.fast) {
    coverage.push({ rule: "build", status: "skipped", reason: "fast" });
  } else {
    const build = await runBuild(options.root);
    pages = build.pages;
    if (!build.ok) {
      if (build.failure === "measure") {
        measurementFailed = true;
        coverage.push({ rule: "build", status: "failed", reason: "measure" });
      } else if (build.failure === undefined || build.failure === "compile") {
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

  const effectivePages = options.fast && previous ? previous.pages : pages;
  const diff = diffBaseline(previous, findings, effectivePages, config.thresholds);
  const summary = summarizeCoverage(coverage);

  if (options.update === true) {
    const refusal = buildFailed
      ? "build"
      : measurementFailed
        ? "measurement"
        : summary.status === "complete"
          ? null
          : summary.status;
    if (refusal) throw new KkomkkomError("errUpdateRefused", { reason: refusal });
    const savedPages = options.fast ? previous?.pages ?? {} : pages;
    await saveBaseline(options.root, buildBaseline(findings, savedPages));
  }

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
