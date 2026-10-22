import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCheck, summarizeCoverage } from "../dist/run.js";

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function project(t, buildMode, status = 200) {
  const root = await mkdtemp(join(tmpdir(), "kkomkkom-run-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "app", "api", "health"), { recursive: true });
  await writeFile(
    join(root, "app", "api", "health", "route.ts"),
    "export async function GET() { return Response.json({ ok: true }); }",
  );
  await writeFile(join(root, "package.json"), JSON.stringify({
    name: "fake-run-app",
    dependencies: { next: "16.0.0" },
  }));
  await mkdir(join(root, "node_modules", "next", "dist", "bin"), { recursive: true });
  await writeFile(join(root, "node_modules", "next", "package.json"), JSON.stringify({
    name: "next",
    version: "16.0.0",
  }));
  await writeFile(join(root, "node_modules", "next", "dist", "bin", "next"), `
    const http = require("node:http");
    const args = process.argv.slice(2);
    if (args[0] === "dev") {
      const port = Number(args[args.indexOf("-p") + 1]);
      const host = args[args.indexOf("--hostname") + 1];
      const server = http.createServer((_req, res) => {
        res.writeHead(${JSON.stringify(status)}, { "content-type": "text/html" });
        res.end("<html>ok</html>");
      });
      server.listen(port, host);
      const stop = () => {
        server.closeAllConnections();
        server.close(() => process.exit(0));
      };
      process.on("SIGTERM", stop);
    } else if (${JSON.stringify(buildMode)} === "compile-fail") {
      console.error("compile failed");
      process.exit(1);
    } else {
      console.log("build ok");
      process.exit(0);
    }
  `);
  return root;
}

test("a normal Next compile failure stays a report failure (exit 1)", async (t) => {
  const root = await project(t, "compile-fail");
  const result = await runCheck({ root, fast: false, strict: false, port: await freePort() });
  assert.equal(result.buildFailed, true);
  assert.equal(result.exitCode, 1);
});

test("a build runner/tool failure is an execution error, not a compile failure", { skip: process.getuid?.() === 0 || process.platform === "win32" }, async (t) => {
  const root = await project(t, "ok");
  const app = join(root, ".next", "server", "app");
  await mkdir(app, { recursive: true });
  await writeFile(join(root, ".next", "build-manifest.json"), JSON.stringify({ rootMainFiles: [], polyfillFiles: [] }));
  const manifest = join(app, "page_client-reference-manifest.js");
  await writeFile(manifest, "x");
  await chmod(manifest, 0o000);
  const port = await freePort();

  await assert.rejects(
    () => runCheck({ root, fast: false, strict: false, port }),
    (error) => {
      assert.equal(error.key, "errBuildRun");
      assert.equal(error.vars.reason, "internal");
      return true;
    },
  );
});

async function config(root, value) {
  await writeFile(join(root, "kkomkkom.config.json"), JSON.stringify(value));
}

test("an intentional fast build skip does not block a complete checked scope", async (t) => {
  const root = await project(t, "ok");
  await config(root, { routePolicies: { "/api/health": { GET: "public" } } });
  const ordinary = await runCheck({ root, fast: true, strict: false, port: await freePort() });
  assert.equal(ordinary.coverage.status, "complete");
  assert.equal(ordinary.exitCode, 0);

  const strict = await runCheck({ root, fast: true, strict: true, port: await freePort() });
  assert.equal(strict.coverage.status, "complete");
  assert.equal(strict.exitCode, 0);
});

test("an ignored route does not make checked routes incomplete", async (t) => {
  const root = await project(t, "ok");
  await mkdir(join(root, "app", "api", "legacy"), { recursive: true });
  await writeFile(join(root, "app", "api", "legacy", "route.ts"), "export function GET() {}");
  await config(root, {
    ignoreRoutes: ["/api/legacy"],
    routePolicies: { "/api/health": { GET: "public" } },
  });
  const result = await runCheck({ root, fast: true, strict: true, port: await freePort() });
  assert.equal(result.coverage.status, "complete");
  const legacy = result.coverage.checks.filter((check) => check.path === "/api/legacy");
  assert.ok(legacy.length > 0);
  assert.ok(legacy.every((check) => check.status === "ignored"));
  assert.equal(result.exitCode, 0);
});

test("a required sample omission stays incomplete and strict fails", async (t) => {
  const root = await project(t, "ok");
  await mkdir(join(root, "app", "api", "orders", "[id]"), { recursive: true });
  await writeFile(
    join(root, "app", "api", "orders", "[id]", "route.ts"),
    "export function GET() { return Response.json({ id: 1 }); }",
  );
  await config(root, { routePolicies: { "/api/health": { GET: "public" } } });
  const result = await runCheck({ root, fast: true, strict: true, port: await freePort() });
  assert.equal(result.coverage.status, "incomplete");
  assert.ok(result.coverage.checks.some(
    (check) => check.rule === "api-auth" && check.status === "failed" && check.reason === "sample-missing",
  ));
  assert.equal(result.exitCode, 1);
});

test("unknown write analysis is unsupported coverage, not a complete static check", async (t) => {
  const root = await project(t, "ok");
  await mkdir(join(root, "app", "api", "wrapped"), { recursive: true });
  await writeFile(
    join(root, "app", "api", "wrapped", "route.ts"),
    "export const POST = withAuth(handler);",
  );
  await config(root, { routePolicies: { "/api/health": { GET: "public" } } });
  const result = await runCheck({ root, fast: true, strict: true, port: await freePort() });
  assert.equal(result.coverage.status, "incomplete");
  assert.ok(result.coverage.checks.some(
    (check) => check.rule === "write-auth" && check.path === "/api/wrapped" &&
      check.status === "unsupported" && check.reason === "unknown",
  ));
  assert.equal(result.exitCode, 1);
});

test("all routes ignored is empty scope, not a pass", async (t) => {
  const root = await project(t, "ok");
  await config(root, { ignoreRoutes: ["/api/*"] });
  const result = await runCheck({ root, fast: true, strict: false, port: await freePort() });
  assert.equal(result.coverage.status, "empty");
  assert.equal(result.coverage.counts.checked, 1); // secrets only
  assert.equal(result.exitCode, 0);
});

test("a statically GET-less POST-only route answering 405 is complete scope", async (t) => {
  const root = await project(t, "ok", 405);
  await writeFile(
    join(root, "app", "api", "health", "route.ts"),
    "export async function POST() { return Response.json({ ok: true }); }",
  );
  await config(root, { routePolicies: { "/api/health": { POST: "public" } } });
  const result = await runCheck({ root, fast: true, strict: true, port: await freePort() });
  assert.equal(result.coverage.status, "complete");
  assert.ok(result.coverage.checks.some(
    (check) => check.rule === "api-auth" && check.status === "checked" &&
      check.reason === "method-not-allowed",
  ));
  assert.equal(result.exitCode, 0);
});

test("CLI JSON exposes schemaVersion 2 and coverage", async (t) => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  const root = await project(t, "ok");
  await config(root, { routePolicies: { "/api/health": { GET: "public" } } });
  const cli = new URL("../dist/cli.js", import.meta.url).pathname;
  const { stdout } = await run(process.execPath, [
    cli, "--fast", "--json", "--port", String(await freePort()),
  ], { cwd: root });
  const payload = JSON.parse(stdout);
  assert.equal(payload.schemaVersion, 2);
  assert.equal(payload.coverage.status, "complete");
  assert.equal(payload.exitCode, 0);
});

function baselineFile(root) {
  return join(root, ".kkomkkom", "baseline.json");
}

async function writeBaselineRaw(root, raw) {
  await mkdir(join(root, ".kkomkkom"), { recursive: true });
  await writeFile(baselineFile(root), raw);
}

const legacyBaseline = (pages = {}) => JSON.stringify({
  version: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
  routes: {},
  pages,
});

async function addMissingChunkManifest(root) {
  await mkdir(join(root, ".next", "static", "chunks"), { recursive: true });
  await writeFile(
    join(root, ".next", "build-manifest.json"),
    JSON.stringify({ rootMainFiles: ["static/chunks/missing.js"], polyfillFiles: [] }),
  );
}

test("build and secret failures make a non-empty scope incomplete", () => {
  const route = { rule: "api-auth", path: "/api/a", method: "GET", status: "checked" };
  const buildFailed = summarizeCoverage([
    route,
    { rule: "build", status: "failed", reason: "compile" },
    { rule: "secrets", status: "checked", reason: "source-scan" },
  ]);
  assert.equal(buildFailed.status, "incomplete");

  const secretsFailed = summarizeCoverage([
    route,
    { rule: "build", status: "checked", reason: "build" },
    { rule: "secrets", status: "failed", reason: "scan" },
  ]);
  assert.equal(secretsFailed.status, "incomplete");
});

test("deliberate fast skips stay non-blocking", () => {
  const summary = summarizeCoverage([
    { rule: "api-auth", path: "/api/a", method: "GET", status: "checked" },
    { rule: "build", status: "skipped", reason: "fast" },
    { rule: "secrets", status: "checked", reason: "source-scan" },
  ]);
  assert.equal(summary.status, "complete");
});

test("a failed check outside routes does not turn an empty route scope into a pass", () => {
  const summary = summarizeCoverage([
    { rule: "secrets", status: "failed", reason: "scan" },
    { rule: "build", status: "failed", reason: "measure" },
  ]);
  assert.equal(summary.status, "empty");
});

test("a normal check never writes a baseline, even on the first run", async (t) => {
  const root = await project(t, "ok");
  await config(root, { routePolicies: { "/api/health": { GET: "public" } } });
  const result = await runCheck({ root, fast: false, strict: false, port: await freePort() });
  assert.equal(result.buildFailed, false);
  assert.equal(result.coverage.status, "complete");
  assert.equal(await readFile(baselineFile(root), "utf8").catch(() => null), null);
});

test("only an explicit update writes, and later checks keep it byte-identical", async (t) => {
  const root = await project(t, "ok");
  await config(root, { routePolicies: { "/api/health": { GET: "public" } } });
  await runCheck({ root, fast: false, update: true, strict: false, port: await freePort() });
  const saved = await readFile(baselineFile(root), "utf8");

  await runCheck({ root, fast: false, strict: false, port: await freePort() });
  assert.equal(await readFile(baselineFile(root), "utf8"), saved);
  assert.deepEqual((await readdir(join(root, ".kkomkkom"))).sort(), ["baseline.json"]);
});

test("a fast update preserves the existing page weights", async (t) => {
  const root = await project(t, "ok");
  await config(root, { routePolicies: { "/api/health": { GET: "public" } } });
  await writeBaselineRaw(root, legacyBaseline({ "/": { firstLoadJs: 123456, method: "manifest-file" } }));

  await runCheck({ root, fast: true, update: true, strict: false, port: await freePort() });
  const saved = JSON.parse(await readFile(baselineFile(root), "utf8"));
  assert.equal(saved.pages["/"].firstLoadJs, 123456);
  assert.equal(saved.pages["/"].method, "manifest-file");
});

test("an explicit update still saves when findings exist, and the run stays blocking", async (t) => {
  const root = await project(t, "ok");
  await config(root, { routePolicies: { "/api/health": { GET: "protected" } } });
  const result = await runCheck({ root, fast: true, update: true, strict: false, port: await freePort() });
  assert.equal(result.exitCode, 1);
  const saved = JSON.parse(await readFile(baselineFile(root), "utf8"));
  assert.equal(saved.routes["/api/health"].verdict, "exposed");
});

test("an update with a missing required sample is refused and preserves the original", async (t) => {
  const root = await project(t, "ok");
  await mkdir(join(root, "app", "api", "orders", "[id]"), { recursive: true });
  await writeFile(
    join(root, "app", "api", "orders", "[id]", "route.ts"),
    "export function GET() { return Response.json({ id: 1 }); }",
  );
  await config(root, { routePolicies: { "/api/health": { GET: "public" } } });
  const original = legacyBaseline();
  await writeBaselineRaw(root, original);

  const port = await freePort();
  await assert.rejects(
    () => runCheck({ root, fast: true, update: true, strict: false, port }),
    (error) => error.key === "errUpdateRefused",
  );
  assert.equal(await readFile(baselineFile(root), "utf8"), original);
});

test("an update after a build failure is refused and preserves the original", async (t) => {
  const root = await project(t, "compile-fail");
  await config(root, { routePolicies: { "/api/health": { GET: "public" } } });
  const original = legacyBaseline();
  await writeBaselineRaw(root, original);

  const port = await freePort();
  await assert.rejects(
    () => runCheck({ root, fast: false, update: true, strict: false, port }),
    (error) => error.key === "errUpdateRefused",
  );
  assert.equal(await readFile(baselineFile(root), "utf8"), original);
});

test("a missing chunk is incomplete coverage, not a zero weight", async (t) => {
  const root = await project(t, "ok");
  await config(root, { routePolicies: { "/api/health": { GET: "public" } } });
  await addMissingChunkManifest(root);

  const result = await runCheck({ root, fast: false, strict: false, port: await freePort() });
  assert.equal(result.coverage.status, "incomplete");
  assert.ok(result.coverage.checks.some(
    (check) => check.rule === "build" && check.status === "failed" && check.reason === "measure",
  ));
  assert.equal(await readFile(baselineFile(root), "utf8").catch(() => null), null);
});

test("an update with a failed measurement is refused and preserves the original", async (t) => {
  const root = await project(t, "ok");
  await config(root, { routePolicies: { "/api/health": { GET: "public" } } });
  await addMissingChunkManifest(root);
  const original = legacyBaseline();
  await writeBaselineRaw(root, original);

  const port = await freePort();
  await assert.rejects(
    () => runCheck({ root, fast: false, update: true, strict: false, port }),
    (error) => error.key === "errUpdateRefused",
  );
  assert.equal(await readFile(baselineFile(root), "utf8"), original);
});

test("a page with no measurement result fails coverage, strict, and update", async (t) => {
  const root = await project(t, "ok");
  await config(root, { routePolicies: { "/api/health": { GET: "public" } } });
  await writeFile(join(root, "app", "page.tsx"), "export default function Page() { return null; }\n");
  const original = JSON.stringify({
    version: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    routes: {},
    pages: { "/": { firstLoadJs: 1000, method: "manifest-file" } },
  });
  await writeBaselineRaw(root, original);

  const port = await freePort();
  const result = await runCheck({ root, fast: false, strict: true, port });
  assert.equal(result.coverage.status, "incomplete");
  assert.ok(result.coverage.checks.some(
    (check) => check.rule === "build" && check.path === "/" &&
      check.status === "failed" && check.reason === "measure",
  ));
  assert.equal(result.exitCode, 1);
  assert.equal(await readFile(baselineFile(root), "utf8"), original);

  const updatePort = await freePort();
  await assert.rejects(
    () => runCheck({ root, fast: false, update: true, strict: false, port: updatePort }),
    (error) => error.key === "errUpdateRefused" && error.vars.reason === "measurement",
  );
  assert.equal(await readFile(baselineFile(root), "utf8"), original);
});

test("a partially measured page set is incomplete and cannot be saved", async (t) => {
  const root = await project(t, "ok");
  await config(root, { routePolicies: { "/api/health": { GET: "public" } } });
  for (const name of ["measured", "missing"]) {
    await mkdir(join(root, "app", name), { recursive: true });
    await writeFile(join(root, "app", name, "page.tsx"), "export default function Page() { return null; }\n");
  }
  await mkdir(join(root, ".next"), { recursive: true });
  await writeFile(
    join(root, ".next", "build-manifest.json"),
    JSON.stringify({ rootMainFiles: [], polyfillFiles: [], pages: { "/measured": [] } }),
  );
  const original = JSON.stringify({
    version: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    routes: {},
    pages: { "/missing": { firstLoadJs: 1000, method: "manifest-file" } },
  });
  await writeBaselineRaw(root, original);

  const result = await runCheck({ root, fast: false, strict: false, port: await freePort() });
  assert.equal(result.coverage.status, "incomplete");
  const failed = result.coverage.checks.filter(
    (check) => check.rule === "build" && check.status === "failed",
  );
  assert.deepEqual(failed.map((check) => check.path), ["/missing"]);
  assert.equal(result.diff.pages.some((page) => page.path === "/measured"), true);

  const updatePort = await freePort();
  await assert.rejects(
    () => runCheck({ root, fast: false, update: true, strict: false, port: updatePort }),
    (error) => error.key === "errUpdateRefused",
  );
  assert.equal(await readFile(baselineFile(root), "utf8"), original);
});

test("an API-only project does not invent page measurements", async (t) => {
  const root = await project(t, "ok");
  await config(root, { routePolicies: { "/api/health": { GET: "public" } } });
  const result = await runCheck({ root, fast: false, strict: true, port: await freePort() });
  assert.equal(result.coverage.status, "complete");
  assert.deepEqual(result.diff.pages, []);
  assert.equal(result.exitCode, 0);
});

test("a reused server leaves its unverified identity in coverage", async (t) => {
  const { createServer } = await import("node:http");
  const root = await project(t, "ok");
  await config(root, { routePolicies: { "/api/health": { GET: "public" } } });
  const port = await freePort();
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end('<html><script src="/_next/static/chunk.js"></script></html>');
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  }));

  const result = await runCheck({ root, fast: true, strict: true, reuse: true, port });
  assert.equal(result.coverage.status, "incomplete");
  assert.ok(result.coverage.checks.some(
    (check) => check.rule === "server" && check.status === "unsupported" &&
      check.reason === "reuse-unverified",
  ));
  assert.equal(result.exitCode, 1);
});

test("a corrupt baseline is a tool error and stays untouched", async (t) => {
  const root = await project(t, "ok");
  await config(root, { routePolicies: { "/api/health": { GET: "public" } } });
  await writeBaselineRaw(root, "{not json");

  const port = await freePort();
  await assert.rejects(
    () => runCheck({ root, fast: true, strict: false, port }),
    (error) => error.key === "errBaseline",
  );
  assert.equal(await readFile(baselineFile(root), "utf8"), "{not json");
});

test("an explicit update accepts a heavier page and records the new weight", async (t) => {
  const root = await project(t, "ok");
  await config(root, { routePolicies: { "/api/health": { GET: "public" } } });
  await mkdir(join(root, ".next", "static", "chunks"), { recursive: true });
  await writeFile(join(root, ".next", "static", "chunks", "page.js"), "x".repeat(50_000));
  await writeFile(
    join(root, ".next", "build-manifest.json"),
    JSON.stringify({ rootMainFiles: [], polyfillFiles: [], pages: { "/": ["static/chunks/page.js"] } }),
  );
  await writeBaselineRaw(root, legacyBaseline({ "/": { firstLoadJs: 1000, method: "manifest-file" } }));

  const result = await runCheck({ root, fast: false, update: true, strict: false, port: await freePort() });
  assert.equal(result.diff.pages.find((page) => page.path === "/").heavy, true);
  assert.equal(result.exitCode, 0);
  const saved = JSON.parse(await readFile(baselineFile(root), "utf8"));
  assert.equal(saved.pages["/"].firstLoadJs, 50_000);
  assert.equal(saved.pages["/"].method, "manifest-file");
});

test("CLI JSON mode reports a corrupt baseline as a tool error (exit 2)", async (t) => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  const root = await project(t, "ok");
  await config(root, { routePolicies: { "/api/health": { GET: "public" } } });
  await writeBaselineRaw(root, "{not json");
  const cli = new URL("../dist/cli.js", import.meta.url).pathname;
  const port = await freePort();

  await assert.rejects(
    () => run(process.execPath, [cli, "--fast", "--json", "--port", String(port)], {
      cwd: root,
      env: { ...process.env, KKOMKKOM_LANG: "en" },
    }),
    (error) => {
      assert.equal(error.code, 2);
      assert.match(error.stderr, /baseline/i);
      assert.equal(error.stdout, "");
      return true;
    },
  );
});
