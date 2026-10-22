import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isPortOpen, startDevServer } from "../dist/server.js";

const SERVER_URL = new URL("../dist/server.js", import.meta.url).href;

async function serve(body, run) {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    await run(port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function fakeNextProject(t, script) {
  const root = await mkdtemp(join(tmpdir(), "kkomkkom-server-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "node_modules", "next", "dist", "bin"), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({
    name: "fake-next-app",
    dependencies: { next: "16.0.0" },
  }));
  await writeFile(join(root, "node_modules", "next", "package.json"), JSON.stringify({
    name: "next",
    version: "16.0.0",
  }));
  await writeFile(join(root, "node_modules", "next", "dist", "bin", "next"), script);
  return root;
}

async function waitForFile(path, timeout = 5000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    try {
      return await readFile(path, "utf8");
    } catch {
      if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

function waitForExit(child, timeout = 10_000) {
  if (child.exitCode !== null) return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("child did not exit")), timeout);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForDead(pid, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (pidAlive(pid)) {
    if (Date.now() >= deadline) throw new Error(`process ${pid} is still alive`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function waitForOutput(stream, needle, timeout = 5000) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${needle}`)), timeout);
    stream.on("data", (chunk) => {
      output += chunk;
      if (output.includes(needle)) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
}

const READY_SCRIPT = `
const fs = require("node:fs");
const { createServer } = require("node:http");
const args = process.argv.slice(2);
fs.writeFileSync(process.env.KKOMKKOM_ARGS_FILE, JSON.stringify({ args, pid: process.pid }));
const port = Number(args[args.indexOf("-p") + 1]);
const host = args[args.indexOf("--hostname") + 1];
const server = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end('<script src="/_next/chunk.js"></script>');
});
server.listen(port, host, () => fs.writeFileSync(process.env.KKOMKKOM_READY_FILE, "ready"));
const stop = () => {
  server.closeAllConnections();
  server.close(() => process.exit(0));
};
process.on("SIGTERM", stop);
`;

const EXIT_SCRIPT = `
const fs = require("node:fs");
fs.writeFileSync(process.env.KKOMKKOM_ARGS_FILE, JSON.stringify({ args: process.argv.slice(2), pid: process.pid }));
console.error("boom super-secret-value");
process.exit(1);
`;

const HANG_SCRIPT = `
const fs = require("node:fs");
fs.writeFileSync(process.env.KKOMKKOM_ARGS_FILE, JSON.stringify({ args: process.argv.slice(2), pid: process.pid }));
setInterval(() => {}, 1000);
`;

const DESCENDANT_PARENT_SCRIPT = `
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const args = process.argv.slice(2);
fs.writeFileSync(process.env.KKOMKKOM_ARGS_FILE, JSON.stringify({ args, pid: process.pid }));
const port = Number(args[args.indexOf("-p") + 1]);
const host = args[args.indexOf("--hostname") + 1];
const child = spawn(process.execPath, [process.env.KKOMKKOM_DESCENDANT_SCRIPT], {
  env: { ...process.env, KKOMKKOM_PORT: String(port), KKOMKKOM_HOST: host },
  stdio: ["ignore", "inherit", "inherit"],
});
fs.writeFileSync(process.env.KKOMKKOM_DESCENDANT_PID_FILE, String(child.pid));
process.exit(0);
`;

const CANCEL_SCRIPT = `
const fs = require("node:fs");
const { createServer } = require("node:http");
const args = process.argv.slice(2);
fs.writeFileSync(process.env.KKOMKKOM_ARGS_FILE, JSON.stringify({ args, pid: process.pid }));
const port = Number(args[args.indexOf("-p") + 1]);
const host = args[args.indexOf("--hostname") + 1];
let first = true;
const server = createServer((_req, res) => {
  if (first) {
    first = false;
    res.writeHead(503, { "content-type": "text/plain" });
    res.write("warming");
    res.on("close", () => fs.writeFileSync(process.env.KKOMKKOM_CANCEL_FILE, "canceled"));
    return;
  }
  res.writeHead(200, { "content-type": "text/html" });
  res.end("ok");
});
server.listen(port, host);
const stop = () => {
  server.closeAllConnections();
  server.close(() => process.exit(0));
};
process.on("SIGTERM", stop);
`;

test("starts the project's Next CLI on 127.0.0.1 and cleans up its own child", async (t) => {
  const root = await fakeNextProject(t, READY_SCRIPT);
  const artifacts = await mkdtemp(join(tmpdir(), "kkomkkom-server-artifacts-"));
  t.after(() => rm(artifacts, { recursive: true, force: true }));
  const argsFile = join(artifacts, "args.json");
  const readyFile = join(artifacts, "ready");
  const npxDir = join(artifacts, "bin");
  const npxMarker = join(artifacts, "npx-called");
  await mkdir(npxDir);
  await writeFile(join(npxDir, "npx"), `#!/bin/sh\ntouch ${JSON.stringify(npxMarker)}\nexit 1\n`);
  await chmod(join(npxDir, "npx"), 0o755);
  const env = {
    KKOMKKOM_ARGS_FILE: argsFile,
    KKOMKKOM_READY_FILE: readyFile,
  };
  const oldEnv = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  const oldPath = process.env.PATH;
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
  process.env.PATH = `${npxDir}:${oldPath}`;

  try {
    const port = await freePort();
    const server = await startDevServer(root, port);
    assert.equal(server.owned, true);
    assert.equal(server.url, `http://127.0.0.1:${port}`);

    await waitForFile(readyFile);
    const { args, pid } = JSON.parse(await readFile(argsFile, "utf8"));
    assert.deepEqual(args, ["dev", "--hostname", "127.0.0.1", "-p", String(port)]);
    assert.equal(await readFile(npxMarker, "utf8").catch(() => null), null);

    const response = await fetch(server.url);
    assert.equal(response.status, 200);
    await response.body?.cancel();

    await server.stop();
    await waitForDead(pid);
    assert.equal(await isPortOpen(port), false);
  } finally {
    process.env.PATH = oldPath;
    for (const [key, value] of Object.entries(oldEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("refuses to start when the project has no installed Next CLI", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "kkomkkom-server-missing-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "no-next" }));
  const port = await freePort();
  await assert.rejects(
    () => startDevServer(root, port),
    (error) => error.key === "errNextMissing",
  );
});

test("fails fast when the child exits before it is ready and redacts its log", async (t) => {
  const root = await fakeNextProject(t, EXIT_SCRIPT);
  await writeFile(join(root, ".env"), "SERVER_SECRET=super-secret-value\n");
  const artifacts = await mkdtemp(join(tmpdir(), "kkomkkom-server-artifacts-"));
  t.after(() => rm(artifacts, { recursive: true, force: true }));
  process.env.KKOMKKOM_ARGS_FILE = join(artifacts, "args.json");
  t.after(() => delete process.env.KKOMKKOM_ARGS_FILE);

  const port = await freePort();
  const started = Date.now();
  await assert.rejects(
    () => startDevServer(root, port),
    (error) => {
      assert.equal(error.key, "errDevStart");
      assert.match(String(error.vars.reason), /exit 1/);
      assert.match(String(error.vars.log), /\[redacted\]/);
      assert.ok(!String(error.vars.log).includes("super-secret-value"));
      return true;
    },
  );
  assert.ok(Date.now() - started < 5000, "must not wait for the 60s readiness timeout");
});

test("times out a hung child and actually cleans it up", async (t) => {
  const root = await fakeNextProject(t, HANG_SCRIPT);
  const artifacts = await mkdtemp(join(tmpdir(), "kkomkkom-server-artifacts-"));
  t.after(() => rm(artifacts, { recursive: true, force: true }));
  const argsFile = join(artifacts, "args.json");
  process.env.KKOMKKOM_ARGS_FILE = argsFile;
  t.after(() => delete process.env.KKOMKKOM_ARGS_FILE);

  const port = await freePort();
  await assert.rejects(
    () => startDevServer(root, port, { startupTimeoutMs: 600, stopTimeoutMs: 1000 }),
    (error) => error.key === "errDevTimeout",
  );
  const { pid } = JSON.parse(await readFile(argsFile, "utf8"));
  await waitForDead(pid);
});

test("SIGINT while running stops the owned child and exits 130", { skip: process.platform === "win32" }, async (t) => {
  const root = await fakeNextProject(t, READY_SCRIPT);
  const artifacts = await mkdtemp(join(tmpdir(), "kkomkkom-server-artifacts-"));
  t.after(() => rm(artifacts, { recursive: true, force: true }));
  const argsFile = join(artifacts, "args.json");
  const readyFile = join(artifacts, "ready");
  const script = join(artifacts, "run.mjs");
  await writeFile(script, `
    const { startDevServer } = await import(process.env.KKOMKKOM_SERVER);
    await startDevServer(process.env.KKOMKKOM_ROOT, Number(process.env.KKOMKKOM_PORT));
    process.stdout.write("READY\\n");
  `);
  const port = await freePort();
  const child = spawn(process.execPath, [script], {
    env: {
      ...process.env,
      KKOMKKOM_SERVER: SERVER_URL,
      KKOMKKOM_ROOT: root,
      KKOMKKOM_PORT: String(port),
      KKOMKKOM_ARGS_FILE: argsFile,
      KKOMKKOM_READY_FILE: readyFile,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => child.kill("SIGKILL"));

  await waitForOutput(child.stdout, "READY");
  const { pid } = JSON.parse(await readFile(argsFile, "utf8"));
  child.kill("SIGINT");
  const { code } = await waitForExit(child);
  assert.equal(code, 130);
  await waitForDead(pid);
});

test("SIGINT while starting stops the child and exits 130", { skip: process.platform === "win32" }, async (t) => {
  const root = await fakeNextProject(t, HANG_SCRIPT);
  const artifacts = await mkdtemp(join(tmpdir(), "kkomkkom-server-artifacts-"));
  t.after(() => rm(artifacts, { recursive: true, force: true }));
  const argsFile = join(artifacts, "args.json");
  const script = join(artifacts, "run.mjs");
  await writeFile(script, `
    const { startDevServer } = await import(process.env.KKOMKKOM_SERVER);
    await startDevServer(process.env.KKOMKKOM_ROOT, Number(process.env.KKOMKKOM_PORT));
  `);
  const port = await freePort();
  const child = spawn(process.execPath, [script], {
    env: {
      ...process.env,
      KKOMKKOM_SERVER: SERVER_URL,
      KKOMKKOM_ROOT: root,
      KKOMKKOM_PORT: String(port),
      KKOMKKOM_ARGS_FILE: argsFile,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => child.kill("SIGKILL"));

  const { pid } = JSON.parse(await waitForFile(argsFile));
  child.kill("SIGINT");
  const { code } = await waitForExit(child);
  assert.equal(code, 130);
  await waitForDead(pid);
});

test("does not trust an HTTP reply after the owned parent exited, and kills its group", { skip: process.platform === "win32" }, async (t) => {
  const root = await fakeNextProject(t, DESCENDANT_PARENT_SCRIPT);
  const artifacts = await mkdtemp(join(tmpdir(), "kkomkkom-server-artifacts-"));
  t.after(() => rm(artifacts, { recursive: true, force: true }));
  const descendantScript = join(artifacts, "descendant.cjs");
  await writeFile(descendantScript, `
    const fs = require("node:fs");
    const { createServer } = require("node:http");
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("ok");
    });
    server.listen(Number(process.env.KKOMKKOM_PORT), process.env.KKOMKKOM_HOST, () => {
      fs.writeFileSync(process.env.KKOMKKOM_READY_FILE, "ready");
    });
    setInterval(() => {}, 1000);
  `);
  const argsFile = join(artifacts, "args.json");
  const readyFile = join(artifacts, "ready");
  const pidFile = join(artifacts, "descendant.pid");
  const env = {
    KKOMKKOM_ARGS_FILE: argsFile,
    KKOMKKOM_READY_FILE: readyFile,
    KKOMKKOM_DESCENDANT_SCRIPT: descendantScript,
    KKOMKKOM_DESCENDANT_PID_FILE: pidFile,
  };
  const oldEnv = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
  let started = null;
  let failure = null;
  try {
    const port = await freePort();
    try {
      started = await startDevServer(root, port, { startupTimeoutMs: 5000, stopTimeoutMs: 1000 });
    } catch (error) {
      failure = error;
    }
    if (started) await started.stop().catch(() => {});
    const { pid: parentPid } = JSON.parse(await waitForFile(argsFile));
    const descendantPid = Number(await waitForFile(pidFile));
    t.after(() => {
      try {
        process.kill(-parentPid, "SIGKILL");
      } catch {
        try {
          process.kill(descendantPid, "SIGKILL");
        } catch {
          // already gone
        }
      }
    });
    assert.equal(failure?.key, "errDevStart");
    await waitForDead(descendantPid);
    assert.equal(await isPortOpen(port), false);
  } finally {
    for (const [key, value] of Object.entries(oldEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("cancels a 5xx readiness body before retrying", async (t) => {
  const root = await fakeNextProject(t, CANCEL_SCRIPT);
  const artifacts = await mkdtemp(join(tmpdir(), "kkomkkom-server-artifacts-"));
  t.after(() => rm(artifacts, { recursive: true, force: true }));
  const argsFile = join(artifacts, "args.json");
  const cancelFile = join(artifacts, "canceled");
  const env = { KKOMKKOM_ARGS_FILE: argsFile, KKOMKKOM_CANCEL_FILE: cancelFile };
  const oldEnv = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
  try {
    const port = await freePort();
    const server = await startDevServer(root, port);
    t.after(() => server.stop().catch(() => {}));
    await waitForFile(cancelFile, 2000);
    assert.equal(await readFile(cancelFile, "utf8"), "canceled");
  } finally {
    for (const [key, value] of Object.entries(oldEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("reuses a running Next.js server only when asked", async () => {
  await serve('<script src="/_next/static/chunk.js"></script>', async (port) => {
    await assert.rejects(
      () => startDevServer("/tmp", port),
      (error) => error.key === "errPortInUse",
    );
    const server = await startDevServer("/tmp", port, { reuse: true });
    assert.equal(server.owned, false);
    await server.stop();
    const response = await fetch(`http://127.0.0.1:${port}`);
    assert.equal(response.status, 200, "reuse must not stop the existing server");
    await response.body?.cancel();
  });
});

test("refuses a port used by another program", async () => {
  await serve("<html>hello</html>", async (port) => {
    for (const reuse of [false, true]) {
      await assert.rejects(
        () => startDevServer("/tmp", port, { reuse }),
        (error) => error.key === "errPortInUse" && error.vars.port === port,
      );
    }
  });
});
