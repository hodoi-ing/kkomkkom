import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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

test("parses decimal MB sizes case-insensitively", () => {
  const output = `
Route (app)                                 Size  First Load JS
┌ ○ /big                                  1.2 MB         2.5 MB
└ ○ /mixed                                1.2 MB          3 Mb
`;
  const pages = parseFirstLoadJs(output);
  assert.equal(pages["/big"].firstLoadJs, 2_500_000);
  assert.equal(pages["/mixed"].firstLoadJs, 3_000_000);
  assert.equal(pages["/big"].method, "next-output");
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

test("a real zero-byte chunk is a measured zero with method metadata", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "kkomkkom-build-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".next", "static", "chunks"), { recursive: true });
  await writeFile(join(root, ".next", "static", "chunks", "zero.js"), "");
  await writeFile(
    join(root, ".next", "build-manifest.json"),
    JSON.stringify({ rootMainFiles: ["static/chunks/zero.js"], polyfillFiles: [], pages: { "/zero": ["static/chunks/zero.js"] } }),
  );

  const pages = await measurePages(root);
  assert.equal(pages["/zero"].firstLoadJs, 0);
  assert.equal(pages["/zero"].method, "manifest-file");
});

test("a missing chunk is a measurement error, not zero", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "kkomkkom-build-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".next", "static", "chunks"), { recursive: true });
  await writeFile(
    join(root, ".next", "build-manifest.json"),
    JSON.stringify({ rootMainFiles: ["static/chunks/missing.js"], polyfillFiles: [] }),
  );

  await assert.rejects(
    () => measurePages(root),
    (error) => {
      assert.equal(error.name, "MeasurementError");
      assert.equal(error.reason, "missing");
      return true;
    },
  );
});

test("a chunk path that is a directory is a measurement error, not its size", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "kkomkkom-build-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".next", "static", "chunks", "shared.js"), { recursive: true });
  await writeFile(
    join(root, ".next", "build-manifest.json"),
    JSON.stringify({ rootMainFiles: ["static/chunks/shared.js"], polyfillFiles: [] }),
  );

  await assert.rejects(
    () => measurePages(root),
    (error) => {
      assert.equal(error.name, "MeasurementError");
      assert.equal(error.reason, "directory");
      return true;
    },
  );
});

test("an unreadable chunk is a measurement error, not zero", { skip: process.getuid?.() === 0 || process.platform === "win32" }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "kkomkkom-build-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".next", "static", "chunks"), { recursive: true });
  await writeFile(join(root, ".next", "static", "chunks", "blocked.js"), "x".repeat(100));
  await chmod(join(root, ".next", "static", "chunks", "blocked.js"), 0o000);
  await writeFile(
    join(root, ".next", "build-manifest.json"),
    JSON.stringify({ rootMainFiles: ["static/chunks/blocked.js"], polyfillFiles: [] }),
  );

  await assert.rejects(
    () => measurePages(root),
    (error) => {
      assert.equal(error.name, "MeasurementError");
      assert.equal(error.reason, "read");
      return true;
    },
  );
});

test("duplicate chunk references are counted once even with mixed prefixes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "kkomkkom-build-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".next", "static", "chunks"), { recursive: true });
  await writeFile(join(root, ".next", "static", "chunks", "shared.js"), "x".repeat(1000));
  await writeFile(join(root, ".next", "static", "chunks", "route.js"), "x".repeat(500));
  await writeFile(
    join(root, ".next", "build-manifest.json"),
    JSON.stringify({
      rootMainFiles: ["/_next/static/chunks/shared.js", "static/chunks/shared.js"],
      polyfillFiles: [],
      pages: {
        "/dup": [
          "/_next/static/chunks/shared.js",
          "/_next/static/chunks/route.js",
          "static/chunks/route.js",
        ],
      },
    }),
  );

  const pages = await measurePages(root);
  assert.equal(pages["/dup"].firstLoadJs, 1500);
});

test("runBuild reports a missing chunk as a measurement failure", async (t) => {
  const root = await fakeNextProject(t, 'console.log("fake build ok");');
  await mkdir(join(root, ".next", "static", "chunks"), { recursive: true });
  await writeFile(
    join(root, ".next", "build-manifest.json"),
    JSON.stringify({ rootMainFiles: ["static/chunks/missing.js"], polyfillFiles: [] }),
  );

  const result = await runBuild(root);
  assert.equal(result.ok, false);
  assert.equal(result.failure, "measure");
  assert.deepEqual(result.pages, {});
});

async function waitForExit(child, timeout = 15000) {
  if (child.exitCode !== null) return { code: child.exitCode, signal: child.signalCode };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("child did not exit")), timeout);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

async function waitForDead(pid, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (true) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    if (Date.now() >= deadline) assert.fail(`process ${pid} is still alive`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function waitForFile(file, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (true) {
    const value = await readFile(file, "utf8").catch(() => null);
    if (value !== null) return value;
    if (Date.now() >= deadline) assert.fail(`file ${file} was not written`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

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

test("runBuild stops waiting when the parent exits but a descendant keeps stdout open", { skip: process.platform === "win32" }, async (t) => {
  const root = await fakeNextProject(t, `
    const fs = require("node:fs");
    const { spawn } = require("node:child_process");
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], {
      stdio: ["ignore", "inherit", "inherit"],
    });
    fs.writeFileSync(process.env.KKOMKKOM_BUILD_CHILD_FILE, String(child.pid));
    console.log("parent build done");
    process.exit(0);
  `);
  const artifacts = await mkdtemp(join(tmpdir(), "kkomkkom-build-artifacts-"));
  t.after(() => rm(artifacts, { recursive: true, force: true }));
  const childFile = join(artifacts, "child.pid");
  process.env.KKOMKKOM_BUILD_CHILD_FILE = childFile;
  t.after(() => delete process.env.KKOMKKOM_BUILD_CHILD_FILE);

  const started = Date.now();
  const result = await runBuild(root, { timeoutMs: 3000, stopTimeoutMs: 300 });
  assert.equal(result.ok, true, `unexpected failure: ${result.failure}`);
  assert.ok(Date.now() - started < 3000, "must not wait for the output pipe or timeout");
  await waitForDead(Number(await waitForFile(childFile)));
});

test("runBuild treats a signal-terminated build as an execution failure", { skip: process.platform === "win32" }, async (t) => {
  const root = await fakeNextProject(t, 'process.kill(process.pid, "SIGTERM");');
  const result = await runBuild(root);
  assert.equal(result.ok, false);
  assert.equal(result.failure, "signal");
});

test("SIGINT during a build stops the owned group and exits 130", { skip: process.platform === "win32" }, async (t) => {
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
  const script = join(artifacts, "run.mjs");
  await writeFile(script, `
    const { runBuild } = await import(process.env.KKOMKKOM_BUILD);
    await runBuild(process.env.KKOMKKOM_ROOT, { timeoutMs: 60000, stopTimeoutMs: 500 });
    process.stdout.write("BUILD-DONE\\n");
  `);
  const env = { KKOMKKOM_BUILD_PID_FILE: pidFile, KKOMKKOM_BUILD_CHILD_FILE: childFile };
  const oldEnv = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
  try {
    const child = spawn(process.execPath, [script], {
      env: {
        ...process.env,
        KKOMKKOM_BUILD: new URL("../dist/build.js", import.meta.url).pathname,
        KKOMKKOM_ROOT: root,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    t.after(() => child.kill("SIGKILL"));
    const pid = Number(await waitForFile(pidFile));
    const childPid = Number(await waitForFile(childFile));

    child.kill("SIGINT");
    const { code } = await waitForExit(child);
    assert.equal(code, 130);
    await waitForDead(pid);
    await waitForDead(childPid);
  } finally {
    for (const [key, value] of Object.entries(oldEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
