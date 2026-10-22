import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { runArtifactCheck } from "../dist/artifacts.js";
import * as httpEngine from "../dist/artifact-http.js";
import { LANGS, t as translate } from "../dist/i18n.js";

const map = Buffer.from('{"version":3,"sources":["a"],"mappings":"AAAA"}');
const MiB = 1024 * 1024;

async function project(t, files = { "public/app.js.map": map }) {
  const root = await mkdtemp(join(tmpdir(), "kk-artifact-http-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [file, content] of Object.entries({
    "package.json": '{"dependencies":{"next":"16.0.0"}}',
    "app/page.tsx": "export default function Page() { return null; }",
    ...files,
  })) {
    await mkdir(dirname(join(root, file)), { recursive: true });
    await writeFile(join(root, file), content);
  }
  return root;
}

async function serve(t, handler) {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push({ url: req.url, method: req.method, headers: req.headers });
    handler(req, res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  return { url: `http://127.0.0.1:${server.address().port}`, requests };
}

function matches(result) {
  return result.extras.filter((finding) => finding.messageKey === "artifactHttpMatch");
}

test("production HTTP validates runtime input before filesystem or build side effects", async () => {
  const invalid = [null, false, 1, {}, [], "", "https://127.0.0.1:3100", "http://example.com",
    "http://localhost.evil", "http://localhost.", "http://127.1", "http://2130706433",
    "http://0x7f000001", "http://127.00.0.1", "http://0.0.0.0", "http://[::]",
    "http://127.0.0.1:0", "http://127.0.0.1:65536", "http://user:private@127.0.0.1",
    "http://127.0.0.1?", "http://127.0.0.1#", "http://127.0.0.1/base", " http://127.0.0.1"];
  for (const productionUrl of invalid) {
    await assert.rejects(runArtifactCheck({ root: "/no-such-project", fresh: true, productionUrl }),
      (error) => error.key === "errProductionUrl");
  }
});

test("production HTTP matches raw bytes, encodes file segments, sends GET only and never reads source as a candidate", async (t) => {
  const file = "public/a #?%.js.map";
  const root = await project(t, {
    [file]: map,
    "public/data.db": Buffer.from([0, 128, 255, 1]),
    ".env": "PRIVATE_TOKEN=ordinary-private-0123456789",
    "app/client.tsx": '"use client"; import pg from "pg";',
    ".kkomkkom-baseline.json": "baseline-sentinel",
  });
  const { url, requests } = await serve(t, (req, res) => {
    res.end(req.url.endsWith("data.db") ? Buffer.from([0, 128, 255, 1]) : map);
  });
  const result = await runArtifactCheck({ root, productionUrl: url.replace("127.0.0.1", "localhost") });
  assert.equal(matches(result).length, 2);
  assert.ok(matches(result).every((finding) => finding.evidenceKind === "local-production-http"));
  assert.ok(result.extras.some((finding) => finding.messageKey === "artifactHttpIdentity"));
  assert.ok(result.extras.some((finding) => finding.rule === "artifact-source-map" && finding.evidenceKind === "artifact"));
  assert.deepEqual(requests.map((req) => req.url).sort(), ["/a%20%23%3F%25.js.map", "/data.db"]);
  for (const req of requests) {
    assert.equal(req.method, "GET");
    assert.equal(req.headers.authorization, undefined);
    assert.equal(req.headers.cookie, undefined);
    assert.match(req.headers.host, /^127\.0\.0\.1:/);
  }
  assert.equal(await readFile(join(root, ".kkomkkom-baseline.json"), "utf8"), "baseline-sentinel");
  assert.ok(!JSON.stringify(result).includes(map.toString()));
});

for (const mode of ["spa", "redirect", "missing", "binary", "prefix", "truncated"]) {
  test(`production HTTP leaves ${mode} responses unconfirmed and preserves static findings`, async (t) => {
    const bytes = mode === "binary" ? Buffer.from([128]) : map;
    const root = await project(t, { "public/app.js.map": bytes });
    const { url, requests } = await serve(t, (req, res) => {
      if (mode === "redirect") { res.writeHead(302, { Location: "/redirected" }); res.end(); }
      if (mode === "missing") { res.writeHead(404); res.end(); }
      if (mode === "spa") res.end("<html>fallback</html>");
      if (mode === "binary") res.end(Buffer.from([129]));
      if (mode === "prefix") res.end(Buffer.concat([bytes, Buffer.from("extra")]));
      if (mode === "truncated") {
        res.writeHead(200, { "Content-Length": bytes.length + 1 });
        res.write(bytes);
        setImmediate(() => res.destroy());
      }
    });
    const result = await runArtifactCheck({ root, productionUrl: url, strict: true });
    assert.equal(matches(result).length, 0);
    assert.equal(requests.length, 1);
    assert.ok(result.coverage.checks.some((check) => check.reason.startsWith("http-") && check.status === "failed"));
    if (mode !== "binary") assert.ok(result.extras.some((finding) => finding.rule === "artifact-source-map"));
    assert.equal(result.exitCode, 1);
  });
}

test("production HTTP distinguishes exact body limit from a truncated matching prefix", async (t) => {
  const bytes = Buffer.alloc(MiB, 120);
  const root = await project(t, { "public/exact.bin": bytes });
  let extra = false;
  const { url } = await serve(t, (req, res) => res.end(extra ? Buffer.concat([bytes, Buffer.from("x")]) : bytes));
  const exact = await runArtifactCheck({ root, productionUrl: url });
  assert.equal(matches(exact).length, 1);
  extra = true;
  const prefix = await runArtifactCheck({ root, productionUrl: url });
  assert.equal(matches(prefix).length, 0);
  assert.ok(prefix.coverage.checks.some((check) => check.reason === "http-body-limit"));
});

test("production HTTP has no candidates for empty or missing outputs, external refs or escaping symlinks", async (t) => {
  const root = await project(t, {});
  const referenceBytes = "//# sourceMappingURL=https://example.com/private.map\n";
  const { url, requests } = await serve(t, (req, res) => res.end(referenceBytes));
  const empty = await runArtifactCheck({ root, productionUrl: url });
  assert.equal(requests.length, 0);
  assert.ok(empty.coverage.checks.some((check) => check.reason === "http-no-candidates" && check.status === "unsupported"));
  assert.equal(matches(empty).length, 0);
  await mkdir(join(root, ".next", "static"), { recursive: true });
  const emptyStatic = await runArtifactCheck({ root, productionUrl: url });
  assert.equal(requests.length, 0);
  assert.ok(emptyStatic.coverage.checks.some((check) => check.reason === "http-no-candidates"));
  await mkdir(join(root, "public"));
  if (process.platform !== "win32") {
    await symlink(join(root, "app", "page.tsx"), join(root, "public", "escape.js"));
    const escaped = await runArtifactCheck({ root, productionUrl: url });
    assert.equal(requests.length, 0);
    assert.ok(escaped.coverage.checks.some((check) => check.reason === "symlink-escape"));
  }
  await writeFile(join(root, "public", "reference.js"), referenceBytes);
  const reference = await runArtifactCheck({ root, productionUrl: url });
  assert.deepEqual(requests.map((req) => req.url), ["/reference.js"]);
  assert.deepEqual(matches(reference).map((finding) => finding.file), ["public/reference.js"]);
  for (const lang of LANGS) {
    assert.ok(translate(lang, "artifactHttpMatch", { file: "public/reference.js" }).includes("public/reference.js"));
  }
});

test("production HTTP caps candidates at 50, concurrency at five and deduplicates URLs", async (t) => {
  const files = Object.fromEntries(Array.from({ length: 55 }, (_, index) => [`public/${index}.bin`, "ok"]));
  files["public/_next/static/shared.js"] = "ok";
  files[".next/static/shared.js"] = "ok";
  const root = await project(t, files);
  let active = 0;
  let max = 0;
  const { url, requests } = await serve(t, (req, res) => {
    active++;
    max = Math.max(max, active);
    setTimeout(() => { active--; res.end("ok"); }, 10);
  });
  const result = await runArtifactCheck({ root, productionUrl: url });
  assert.equal(requests.length, 50);
  assert.equal(new Set(requests.map((req) => req.url)).size, 50);
  assert.ok(max > 1 && max <= 5);
  assert.ok(result.coverage.checks.some((check) => check.reason === "http-candidate-limit"));
  assert.ok(result.coverage.checks.some((check) => check.reason === "http-duplicate-url"));
});

test("production HTTP response budget is separate from local reads and visibly stops at 32 MiB", async (t) => {
  const root = await project(t, Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`public/${i}.bin`, "x"])));
  t.mock.method(globalThis, "fetch", async () => new Response(Buffer.alloc(MiB, 120)));
  const result = await runArtifactCheck({ root, productionUrl: "http://127.0.0.1:3100" });
  assert.equal(matches(result).length, 0);
  assert.ok(result.coverage.checks.some((check) => check.reason === "http-total-budget"));
});

test("production HTTP refuses conflicting URL aliases and static mode performs no requests", async (t) => {
  const root = await project(t, {
    "public/_next/static/shared.js": "public-content",
    ".next/static/shared.js": "different-built-content",
  });
  const { url, requests } = await serve(t, (req, res) => res.end("public-content"));
  const plain = await runArtifactCheck({ root });
  assert.equal(requests.length, 0);
  assert.equal(matches(plain).length, 0);
  const result = await runArtifactCheck({ root, productionUrl: url });
  assert.equal(requests.length, 0);
  assert.equal(matches(result).length, 0);
  assert.ok(result.coverage.checks.some((check) => check.reason === "http-url-conflict"));
  assert.ok(result.coverage.checks.some((check) => check.reason === "http-no-candidates"));
});

test("production HTTP caps accepted payload bytes and cancels streams at the shared response budget", async () => {
  assert.equal(typeof httpEngine.readArtifactBody, "function");
  let bytes = 0;
  let peak = 0;
  let cancelled = 0;
  const budget = {
    get bytes() { return bytes; },
    set bytes(value) { bytes = value; peak = Math.max(peak, value); },
  };
  const response = () => {
    let remaining = MiB;
    return new Response(new ReadableStream({
      pull(controller) {
        if (remaining === 0) { controller.close(); return; }
        const chunk = Math.min(65536, remaining);
        controller.enqueue(new Uint8Array(chunk));
        remaining -= chunk;
      },
      cancel() { cancelled++; },
    }, { highWaterMark: 0 }));
  };
  const signal = new AbortController().signal;
  for (let i = 0; i < 32; i++) {
    const body = await httpEngine.readArtifactBody(response(), budget, signal);
    assert.equal(body.length, MiB);
  }
  assert.equal(bytes, 32 * MiB);
  await assert.rejects(httpEngine.readArtifactBody(response(), budget, signal), /http-total-budget/);
  assert.equal(bytes, 32 * MiB);
  assert.equal(cancelled, 1);
  bytes = 30 * MiB;
  const concurrent = await Promise.allSettled(Array.from({ length: 5 }, () =>
    httpEngine.readArtifactBody(response(), budget, signal)));
  assert.equal(peak, 32 * MiB);
  assert.equal(bytes, 32 * MiB);
  assert.equal(concurrent.filter((result) => result.status === "rejected").length, 5);
  assert.equal(cancelled, 6);
});

test("production HTTP times out a real loopback response after headers and partial body", async (t) => {
  const root = await project(t);
  let closed;
  const cancelled = new Promise((resolve) => { closed = resolve; });
  const { url } = await serve(t, (req, res) => {
    res.writeHead(200);
    res.write(map.subarray(0, 5));
    res.on("close", closed);
  });
  const started = Date.now();
  const result = await runArtifactCheck({ root, productionUrl: url });
  assert.equal(matches(result).length, 0);
  assert.ok(result.coverage.checks.some((check) => check.reason === "http-timeout"));
  assert.ok(Date.now() - started >= 4900 && Date.now() - started < 9000);
  await cancelled;
});

test("production HTTP request and overall timer callbacks independently abort outstanding work", async (t) => {
  const root = await project(t);
  for (const deadline of [5000, 60000]) {
    let started;
    const ready = new Promise((resolve) => { started = resolve; });
    const timers = new Map();
    t.mock.method(globalThis, "setTimeout", (callback, delay) => {
      timers.set(delay, callback);
      return { ref() {}, unref() {} };
    });
    t.mock.method(globalThis, "fetch", async (url, { signal }) => {
      started();
      return new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    });
    const pending = runArtifactCheck({ root, productionUrl: "http://127.0.0.1:3100" });
    await ready;
    assert.ok(timers.has(5000) && timers.has(60000));
    timers.get(deadline)();
    const result = await pending;
    assert.equal(matches(result).length, 0);
    assert.ok(result.coverage.checks.some((check) => check.reason === (deadline === 5000 ? "http-timeout" : "http-total-timeout")));
    t.mock.restoreAll();
  }
});

async function cli(root, args) {
  const child = spawn(process.execPath, [join(process.cwd(), "dist/cli.js"), ...args], { cwd: root });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

test("production HTTP CLI validates mode and origin, supports five languages and never prints candidate contents", async (t) => {
  const root = await project(t);
  const { url } = await serve(t, (req, res) => res.end(map));
  for (const args of [["--production-url", url], ["--artifacts", "--production-url", ""],
    ["--artifacts", "--production-url", "http://user:private@127.0.0.1"]]) {
    const result = await cli(root, args);
    assert.equal(result.status, 2);
    assert.ok(!result.stderr.includes("user:private"));
  }
  for (const lang of LANGS) {
    const result = await cli(root, ["--artifacts", "--production-url", url, "--lang", lang, "--json"]);
    assert.equal(result.status, 0);
    const payload = JSON.parse(result.stdout);
    assert.ok(payload.extra.some((finding) => finding.evidenceKind === "local-production-http"));
    assert.ok(!`${result.stdout}${result.stderr}`.includes(map.toString()));
    assert.ok(!result.stdout.includes("{file}"));
  }
});

async function rpc(t) {
  const child = spawn(process.execPath, [join(process.cwd(), "dist/mcp.js")], { stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => child.kill());
  let id = 0;
  let buffer = "";
  const pending = new Map();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const message = JSON.parse(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    }
  });
  return (method, params) => new Promise((resolve, reject) => {
    const current = ++id;
    const timer = setTimeout(() => reject(new Error("MCP timeout")), 10000);
    pending.set(current, (response) => { clearTimeout(timer); resolve(response); });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: current, method, params }) + "\n");
  });
}

test("production HTTP MCP schema and runtime reject malicious arguments, preserve stream and serve normal tools/call", async (t) => {
  const root = await project(t);
  const { url } = await serve(t, (req, res) => res.end(map));
  const call = await rpc(t);
  const schema = await call("tools/list");
  assert.equal(schema.result.tools[0].inputSchema.properties.productionUrl.type, "string");
  for (const args of [{ productionUrl: url }, ...[false, null, {}, "http://example.com", "http://user:private@127.0.0.1"].map((productionUrl) => ({ artifacts: true, productionUrl }))]) {
    const response = await call("tools/call", { name: "kkomkkom", arguments: { projectPath: root, ...args } });
    assert.equal(response.result.isError, true);
    assert.equal(response.result.structuredContent, undefined);
    assert.ok(!JSON.stringify(response).includes("user:private"));
  }
  const result = await call("tools/call", { name: "kkomkkom", arguments: { projectPath: root, artifacts: true, productionUrl: url } });
  assert.equal(result.result.isError, false);
  assert.equal(matches({ extras: result.result.structuredContent.extra }).length, 1);
});
