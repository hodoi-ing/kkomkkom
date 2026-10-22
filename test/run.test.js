import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCheck } from "../dist/run.js";

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
