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

async function project(t, buildMode) {
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
        res.writeHead(200, { "content-type": "text/html" });
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
