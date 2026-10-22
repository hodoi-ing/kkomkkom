import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { measurePages, parseFirstLoadJs, runBuild } from "../dist/build.js";
import { resolveNextCli } from "../dist/next.js";

const APP_ROUTER_OUTPUT = `
Route (app)                                 Size  First Load JS
┌ ○ /                                    1.24 kB         120 kB
├ ○ /_not-found                            987 B         101 kB
├ ƒ /api/users                               0 B             0 B
├ ƒ /api/orders/[id]                         0 B             0 B
├ ○ /checkout                             5.12 kB         180 kB
└ ○ /dashboard                             2.00 kB         140 kB
+ First Load JS shared by all             99.9 kB
`;

const PAGES_ROUTER_OUTPUT = `
Route (pages)                              Size  First Load JS
┌ ○ /                                      1.2 kB         110 kB
├   /_app                                     0 B          99 kB
├ ƒ /api/health                               0 B            0 B
└ ○ /pricing                               3.4 kB         130 kB
+ First Load JS shared by all               99 kB
`;

test("parses app router build output", () => {
  const pages = parseFirstLoadJs(APP_ROUTER_OUTPUT);
  assert.equal(pages["/"].firstLoadJs, 120_000);
  assert.equal(pages["/checkout"].firstLoadJs, 180_000);
  assert.equal(pages["/dashboard"].firstLoadJs, 140_000);
  assert.equal(pages["/api/users"], undefined);
});

test("parses pages router build output", () => {
  const pages = parseFirstLoadJs(PAGES_ROUTER_OUTPUT);
  assert.equal(pages["/"].firstLoadJs, 110_000);
  assert.equal(pages["/pricing"].firstLoadJs, 130_000);
  assert.equal(pages["/api/health"], undefined);
});

test("returns empty map for unreadable output", () => {
  assert.deepEqual(parseFirstLoadJs("some unrelated log"), {});
});

test("measurePages sums shared and route-specific chunks", async () => {
  const root = await mkdtemp(join(tmpdir(), "kkomkkom-build-"));
  await mkdir(join(root, ".next", "static", "chunks"), { recursive: true });
  await mkdir(join(root, ".next", "server", "app", "checkout"), { recursive: true });
  await writeFile(join(root, ".next", "static", "chunks", "shared.js"), "x".repeat(1000));
  await writeFile(join(root, ".next", "static", "chunks", "route.js"), "x".repeat(500));
  await writeFile(
    join(root, ".next", "build-manifest.json"),
    JSON.stringify({ rootMainFiles: ["static/chunks/shared.js"], polyfillFiles: [] }),
  );
  await writeFile(
    join(root, ".next", "server", "app", "checkout", "page_client-reference-manifest.js"),
    'globalThis.x = ["/_next/static/chunks/route.js"];',
  );

  const pages = await measurePages(root);
  assert.equal(pages["/checkout"].firstLoadJs, 1500);
  await rm(root, { recursive: true, force: true });
});

test("measurePages finds chunks written without the /_next prefix", async () => {
  const root = await mkdtemp(join(tmpdir(), "kkomkkom-build-"));
  await mkdir(join(root, ".next", "static", "chunks"), { recursive: true });
  await mkdir(join(root, ".next", "server", "app", "checkout"), { recursive: true });
  await writeFile(join(root, ".next", "static", "chunks", "shared.js"), "x".repeat(1000));
  await writeFile(join(root, ".next", "static", "chunks", "route.js"), "x".repeat(500));
  await writeFile(
    join(root, ".next", "build-manifest.json"),
    JSON.stringify({ rootMainFiles: ["static/chunks/shared.js"], polyfillFiles: [] }),
  );
  await writeFile(
    join(root, ".next", "server", "app", "checkout", "page_client-reference-manifest.js"),
    'globalThis.x = ["static/chunks/route.js"];',
  );

  const pages = await measurePages(root);
  assert.equal(pages["/checkout"].firstLoadJs, 1500);
  await rm(root, { recursive: true, force: true });
});

async function fakeNextProject(t, script) {
  const root = await mkdtemp(join(tmpdir(), "kkomkkom-build-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "node_modules", "next", "dist", "bin"), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({
    name: "fake-build-app",
    dependencies: { next: "16.0.0" },
  }));
  await writeFile(join(root, "node_modules", "next", "package.json"), JSON.stringify({
    name: "next",
    version: "16.0.0",
  }));
  await writeFile(join(root, "node_modules", "next", "dist", "bin", "next"), script);
  return root;
}

test("resolveNextCli finds only the project's installed Next CLI", async (t) => {
  const root = await fakeNextProject(t, "");
  assert.equal(resolveNextCli(root), join(root, "node_modules", "next", "dist", "bin", "next"));

  const empty = await mkdtemp(join(tmpdir(), "kkomkkom-build-empty-"));
  t.after(() => rm(empty, { recursive: true, force: true }));
  await writeFile(join(empty, "package.json"), JSON.stringify({ name: "empty" }));
  assert.equal(resolveNextCli(empty), null);
});

test("runBuild runs the installed Next CLI with Node and never calls npx", async (t) => {
  const root = await fakeNextProject(t, 'console.log("fake build ok");');
  const bin = await mkdtemp(join(tmpdir(), "kkomkkom-build-bin-"));
  t.after(() => rm(bin, { recursive: true, force: true }));
  const marker = join(bin, "npx-called");
  await writeFile(join(bin, "npx"), `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nexit 1\n`);
  await chmod(join(bin, "npx"), 0o755);

  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  try {
    const result = await runBuild(root);
    assert.equal(result.ok, true);
    assert.match(result.output, /fake build ok/);
    assert.equal(await readFile(marker, "utf8").catch(() => null), null);
  } finally {
    process.env.PATH = oldPath;
  }
});

test("runBuild reports a missing Next CLI instead of downloading one", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "kkomkkom-build-missing-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "no-next" }));
  const result = await runBuild(root);
  assert.equal(result.ok, false);
  assert.equal(result.failure, "missing");
  assert.match(result.output, /Next\.js/);
});

test("runBuild separates a normal compile failure from a runner failure", async (t) => {
  const root = await fakeNextProject(t, 'console.error("compile boom"); process.exit(1);');
  const result = await runBuild(root);
  assert.equal(result.ok, false);
  assert.equal(result.failure, "compile");
  assert.match(result.output, /compile boom/);
});

test("runBuild reports a synchronous spawn failure", async (t) => {
  const root = await fakeNextProject(t, "");
  const result = await runBuild(root, {
    spawnImpl: () => {
      throw new Error("spawn boom");
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.failure, "spawn");
});

test("runBuild handles an asynchronous spawn error", async (t) => {
  const root = await fakeNextProject(t, "");
  const { EventEmitter } = await import("node:events");
  const result = await runBuild(root, {
    spawnImpl: () => {
      const child = new EventEmitter();
      child.stdout = null;
      child.stderr = null;
      child.pid = undefined;
      setImmediate(() => child.emit("error", new Error("spawn async boom")));
      return child;
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.failure, "spawn");
});

test("runBuild timeout is an execution failure and kills its process group", { skip: process.platform === "win32" }, async (t) => {
  const root = await fakeNextProject(t, `
    const fs = require("node:fs");
    const { spawn } = require("node:child_process");
    fs.writeFileSync(process.env.KKOMKKOM_BUILD_PID_FILE, String(process.pid));
    const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"], {
      stdio: "ignore",
    });
    fs.writeFileSync(process.env.KKOMKKOM_BUILD_CHILD_FILE, String(child.pid));
    setInterval(() => {}, 1000);
  `);
  const artifacts = await mkdtemp(join(tmpdir(), "kkomkkom-build-artifacts-"));
  t.after(() => rm(artifacts, { recursive: true, force: true }));
  const pidFile = join(artifacts, "build.pid");
  const childFile = join(artifacts, "child.pid");
  const env = { KKOMKKOM_BUILD_PID_FILE: pidFile, KKOMKKOM_BUILD_CHILD_FILE: childFile };
  const oldEnv = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
  try {
    const result = await runBuild(root, { timeoutMs: 200, stopTimeoutMs: 300 });
    assert.equal(result.ok, false);
    assert.equal(result.failure, "timeout");
    const pid = Number(await readFile(pidFile, "utf8"));
    const childPid = Number(await readFile(childFile, "utf8"));
    for (const id of [pid, childPid]) {
      const deadline = Date.now() + 5000;
      while (true) {
        try {
          process.kill(id, 0);
        } catch {
          break;
        }
        if (Date.now() >= deadline) assert.fail(`process ${id} is still alive`);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
  } finally {
    for (const [key, value] of Object.entries(oldEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("runBuild turns a manifest read failure into an execution failure", { skip: process.getuid?.() === 0 || process.platform === "win32" }, async (t) => {
  const root = await fakeNextProject(t, 'console.log("fake build ok");');
  const app = join(root, ".next", "server", "app");
  await mkdir(app, { recursive: true });
  await writeFile(join(root, ".next", "build-manifest.json"), JSON.stringify({ rootMainFiles: [], polyfillFiles: [] }));
  const manifest = join(app, "page_client-reference-manifest.js");
  await writeFile(manifest, "x");
  await chmod(manifest, 0o000);

  const result = await runBuild(root);
  assert.equal(result.ok, false);
  assert.equal(result.failure, "internal");
});
