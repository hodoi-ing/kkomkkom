import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { isPortOpen } from "../dist/server.js";

const engine = await import("../dist/protect.js").catch(() => ({}));
const serverModule = await import("../dist/server.js");
const original = "module.exports = { productionBrowserSourceMaps: true };\n";
const expectedHash = createHash("sha256").update(original).digest("hex");
async function fixture(t, behavior) {
  const root = await mkdtemp("/tmp/opencode/kk-protect-verification-");
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "node_modules", "next", "dist", "bin"), { recursive: true });
  await writeFile(join(root, "node_modules", "next", "package.json"), JSON.stringify({ name: "next", version: "0.0.0-fixture" }));
  await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { next: "0.0.0-fixture" } }));
  await writeFile(join(root, "next.config.js"), original);
  await mkdir(join(root, "app"));
  await writeFile(join(root, "app", "page.tsx"), "export default function Page() { return null; }");
  await writeFile(join(root, "node_modules", "next", "dist", "bin", "next"), `
    const fs = require('node:fs');
    const http = require('node:http');
    const behavior = ${JSON.stringify(behavior)};
    if (process.argv[2] === 'build') {
      if (behavior === 'build-wait') { fs.writeFileSync('interrupt-ready', 'build'); setInterval(() => {}, 1000); return; }
      if (behavior === 'build-user-edit') fs.appendFileSync('next.config.js', '// later user change');
      fs.mkdirSync('.next/static/chunks', { recursive: true });
      fs.writeFileSync('.next/BUILD_ID', 'fixture-production');
      fs.writeFileSync('.next/static/chunks/main.js', 'console.log("fixture")');
      fs.writeFileSync('build-side-effect', 'generated, not rolled back');
      if (behavior === 'maps') fs.writeFileSync('.next/static/chunks/main.js.map', JSON.stringify({version:3,sources:['entry.js'],names:[],mappings:''}));
      process.exit(behavior.startsWith('build-') ? 1 : 0);
    }
    if (process.argv[2] !== 'start' || process.argv[3] !== '--hostname' || process.argv[4] !== '127.0.0.1') process.exit(91);
    const port = Number(process.argv[6]);
    fs.writeFileSync('owned-port', String(port));
    if (behavior === 'start-fail') process.exit(92);
    let rootRequests = 0;
    http.createServer((req, res) => {
      if (req.url === '/' && behavior === 'smoke-wait' && ++rootRequests > 1) { fs.writeFileSync('interrupt-ready', 'smoke'); return; }
      res.statusCode = behavior === 'smoke-fail' ? 404 : 200;
      res.end(req.url === '/_next/static/chunks/main.js' ? fs.readFileSync('.next/static/chunks/main.js') : 'production-fixture');
    }).listen(port, '127.0.0.1');
  `);
  execFileSync("git", ["init", "-q", root]);
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });
  git("config", "user.email", "fixture@example.invalid");
  git("config", "user.name", "Fixture");
  git("add", "next.config.js", "package.json");
  git("commit", "-qm", "fixture");
  return root;
}

test("protection verification uses an owned start server and closes its port on success", async (t) => {
  assert.equal(typeof engine.applyAndVerifyProtection, "function");
  const root = await fixture(t, "success");
  const result = await engine.applyAndVerifyProtection(root, expectedHash);
  assert.equal(result.exitCode, 0, JSON.stringify(result));
  assert.equal(result.status, "applied");
  assert.equal(result.rollback, "not-needed");
  assert.equal(result.verification.build, "passed");
  assert.equal(result.verification.smoke, "passed");
  assert.equal(result.verification.artifacts, "passed");
  assert.equal(result.verification.cleanup, "passed");
  assert.match(await readFile(join(root, "next.config.js"), "utf8"), /SourceMaps: false/);
  assert.equal(await isPortOpen(Number(await readFile(join(root, "owned-port"), "utf8"))), false);
  await engine.restoreProtection(root, result.transactionId);
  assert.equal(await readFile(join(root, "next.config.js"), "utf8"), original);
});

test("protection interrupt stops owned build/production and hash-safely rolls back before exiting", async (t) => {
  const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
  for (const [behavior, signal, expectedCode] of [["build-wait", "SIGINT", 130], ["smoke-wait", "SIGTERM", 143]]) {
    const root = await fixture(t, behavior);
    const child = spawn(process.execPath, [cli, "--protect-sourcemaps", "--apply", "--expected-hash", expectedHash, "--json", "--lang", "en"], {
      cwd: root, stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => output += chunk);
    child.stderr.on("data", (chunk) => stderr += chunk);
    const closed = new Promise((resolve) => child.once("close", (code, endedSignal) => resolve({ code, signal: endedSignal })));
    const timeout = setTimeout(() => child.kill("SIGKILL"), 12000);
    t.after(async () => {
      clearTimeout(timeout);
      if (child.exitCode === null && child.signalCode === null) { child.kill("SIGINT"); await closed; }
    });
    const deadline = Date.now() + 8000;
    while (true) {
      if (await readFile(join(root, "interrupt-ready"), "utf8").catch(() => null)) break;
      assert.ok(Date.now() < deadline, `interrupt readiness timeout: ${stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const active = (await readFile(join(root, ".kkomkkom", "protection", "active"), "utf8")).trim();
    await assert.rejects(engine.restoreProtection(root, active), /locked/);
    child.kill(signal);
    const exit = await closed;
    clearTimeout(timeout);
    assert.equal(exit.code, expectedCode, stderr);
    assert.equal(exit.signal, null);
    assert.equal(await readFile(join(root, "next.config.js"), "utf8"), original);
    const result = JSON.parse(output);
    assert.equal(result.rollback, "restored");
    if (behavior === "smoke-wait") assert.equal(await isPortOpen(Number(await readFile(join(root, "owned-port"), "utf8"))), false);
  }
});

test("protection failed build rolls back config only and separately reports user-edit refusal", async (t) => {
  assert.equal(typeof engine.applyAndVerifyProtection, "function");
  for (const behavior of ["build-fail", "build-user-edit"]) {
    const root = await fixture(t, behavior);
    const result = await engine.applyAndVerifyProtection(root, expectedHash);
    assert.equal(result.exitCode, 1);
    assert.equal(result.status, "verification-failed");
    assert.equal(result.verification.build, "failed");
    assert.equal(result.verification.smoke, "not-run");
    assert.equal(result.rollback, behavior === "build-fail" ? "restored" : "refused");
    assert.equal(result.configChanged, behavior !== "build-fail");
    assert.equal(await readFile(join(root, "build-side-effect"), "utf8"), "generated, not rolled back");
    const current = await readFile(join(root, "next.config.js"), "utf8");
    assert.equal(current, behavior === "build-fail" ? original : original.replace(": true", ": false") + "// later user change");
  }
});

test("protection map/start/smoke failures roll back and always stop owned production", async (t) => {
  assert.equal(typeof engine.applyAndVerifyProtection, "function");
  for (const behavior of ["maps", "start-fail", "smoke-fail"]) {
    const root = await fixture(t, behavior);
    const result = await engine.applyAndVerifyProtection(root, expectedHash);
    assert.equal(result.exitCode, 1, behavior);
    assert.equal(result.rollback, "restored", behavior);
    assert.equal(await readFile(join(root, "next.config.js"), "utf8"), original);
    const port = Number(await readFile(join(root, "owned-port"), "utf8"));
    assert.equal(await isPortOpen(port), false, behavior);
  }
});

test("owned production startup rejects an existing listener rather than reusing dev evidence", async (t) => {
  assert.equal(typeof serverModule.startProductionServer, "function");
  const listener = createServer();
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => listener.close(resolve)));
  const port = listener.address().port;
  const root = await fixture(t, "success");
  await assert.rejects(serverModule.startProductionServer(root, port, { reuse: true }));
  assert.equal(await isPortOpen(port), true);
});
