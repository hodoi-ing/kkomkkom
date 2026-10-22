import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

function startServer() {
  const child = spawn(process.execPath, ["dist/mcp.js"], { stdio: ["pipe", "pipe", "inherit"] });
  const rl = createInterface({ input: child.stdout });
  const messages = [];
  const waiters = [];
  let exited = null;

  child.on("exit", (code, signal) => {
    exited = `mcp exited: ${code ?? signal}`;
    for (const waiter of waiters.splice(0)) waiter.reject(new Error(exited));
  });

  rl.on("line", (line) => {
    const message = JSON.parse(line);
    const waiter = waiters.shift();
    if (waiter) waiter.resolve(message);
    else messages.push(message);
  });

  const next = (timeout = 4000) =>
    new Promise((resolve, reject) => {
      const ready = messages.shift();
      if (ready) return resolve(ready);
      if (exited) return reject(new Error(exited));
      const waiter = { resolve, reject };
      const timer = setTimeout(() => {
        const index = waiters.indexOf(waiter);
        if (index >= 0) waiters.splice(index, 1);
        reject(new Error("timed out waiting for an MCP response"));
      }, timeout);
      waiter.resolve = (message) => {
        clearTimeout(timer);
        resolve(message);
      };
      waiter.reject = (error) => {
        clearTimeout(timer);
        reject(error);
      };
      waiters.push(waiter);
    });

  const send = (message) => child.stdin.write(JSON.stringify(message) + "\n");
  const sendRaw = (line) => child.stdin.write(line + "\n");
  return { child, send, sendRaw, next };
}

test("mcp server answers initialize and tools/list", async () => {
  const server = startServer();
  try {
    server.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } });
    const init = await server.next();
    assert.equal(init.id, 1);
    assert.equal(init.result.serverInfo.name, "kkomkkom");
    assert.ok(init.result.capabilities.tools);

    server.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const list = await server.next();
    assert.equal(list.id, 2);
    assert.equal(list.result.tools[0].name, "kkomkkom");
    assert.equal(list.result.tools[0].inputSchema.type, "object");
  } finally {
    server.child.kill();
  }
});

test("mcp server returns method-not-found for unknown methods", async () => {
  const server = startServer();
  try {
    server.send({ jsonrpc: "2.0", id: 9, method: "does/not/exist" });
    const response = await server.next();
    assert.equal(response.error.code, -32601);
  } finally {
    server.child.kill();
  }
});

test("malformed frames do not kill the stream and later requests still work", async () => {
  const server = startServer();
  try {
    server.sendRaw("null");
    assert.equal((await server.next()).error.code, -32600);

    server.sendRaw("[1,2]");
    assert.equal((await server.next()).error.code, -32600);

    server.sendRaw("{bad");
    assert.equal((await server.next()).error.code, -32700);

    server.send({ jsonrpc: "2.0", id: 10, method: "initialize" });
    assert.equal((await server.next()).id, 10);

    server.send({ jsonrpc: "2.0", id: 11, method: "tools/list" });
    assert.equal((await server.next()).id, 11);
  } finally {
    server.child.kill();
  }
});

test("invalid tool arguments are rejected without echoing values or killing the stream", async () => {
  const server = startServer();
  try {
    const invalidCases = [
      { arguments: { projectPath: 123 }, field: "projectPath" },
      { arguments: { fast: "yes" }, field: "fast" },
      { arguments: null, field: "arguments" },
      { arguments: [], field: "arguments" },
    ];
    let id = 20;
    for (const item of invalidCases) {
      server.send({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name: "kkomkkom", arguments: item.arguments },
      });
      const response = await server.next();
      assert.equal(response.result.isError, true);
      assert.match(response.result.content[0].text, new RegExp(item.field));
      assert.ok(!response.result.content[0].text.includes("123"));
      assert.ok(!response.result.content[0].text.includes("yes"));
      id += 1;
    }

    const secret = "sk_live_FAKE0123456789ABCDEF";
    server.send({
      jsonrpc: "2.0",
      id: 30,
      method: "tools/call",
      params: { name: "kkomkkom", arguments: { projectPath: "/tmp", lang: secret } },
    });
    const langError = await server.next();
    assert.equal(langError.result.isError, true);
    assert.match(langError.result.content[0].text, /lang/);
    assert.ok(!langError.result.content[0].text.includes(secret));

    server.send({ jsonrpc: "2.0", id: 31, method: "tools/list" });
    assert.equal((await server.next()).id, 31);
  } finally {
    server.child.kill();
  }
});

test("a project lookup failure does not echo the supplied path", async () => {
  const server = startServer();
  const secret = "sk_live_FAKE0123456789ABCDEF";
  const dir = await mkdtemp(join(tmpdir(), `kkomkkom-${secret}-`));
  try {
    server.send({
      jsonrpc: "2.0",
      id: 40,
      method: "tools/call",
      params: { name: "kkomkkom", arguments: { projectPath: dir } },
    });
    const response = await server.next();
    assert.equal(response.result.isError, true);
    assert.ok(!response.result.content[0].text.includes(secret));

    server.send({ jsonrpc: "2.0", id: 41, method: "ping" });
    assert.equal((await server.next()).id, 41);
  } finally {
    server.child.kill();
    await rm(dir, { recursive: true, force: true });
  }
});

async function fakeProject() {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "kkomkkom-mcp-"));
  await mkdir(join(root, "app", "api", "health"), { recursive: true });
  await writeFile(
    join(root, "app", "api", "health", "route.ts"),
    "export async function GET() { return Response.json({ ok: true }); }",
  );
  await writeFile(join(root, "kkomkkom.config.json"),
    JSON.stringify({ routePolicies: { "/api/health": { GET: "public" } } }));
  await writeFile(join(root, "package.json"), JSON.stringify({
    name: "fake-mcp-app", dependencies: { next: "16.0.0" },
  }));
  await mkdir(join(root, "node_modules", "next", "dist", "bin"), { recursive: true });
  await writeFile(join(root, "node_modules", "next", "package.json"),
    JSON.stringify({ name: "next", version: "16.0.0" }));
  await writeFile(join(root, "node_modules", "next", "dist", "bin", "next"), `
    const http = require("node:http");
    const args = process.argv.slice(2);
    const port = Number(args[args.indexOf("-p") + 1]);
    const host = args[args.indexOf("--hostname") + 1];
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html>ok</html>");
    });
    server.listen(port, host);
    process.on("SIGTERM", () => {
      server.closeAllConnections();
      server.close(() => process.exit(0));
    });
  `);
  return root;
}

test("a corrupt baseline is a tool error and the MCP stream survives", async () => {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const server = startServer();
  const root = await fakeProject();
  await mkdir(join(root, ".kkomkkom"), { recursive: true });
  await writeFile(join(root, ".kkomkkom", "baseline.json"), "{not json");
  try {
    server.send({
      jsonrpc: "2.0", id: 60, method: "tools/call",
      params: { name: "kkomkkom", arguments: { projectPath: root, fast: true } },
    });
    const response = await server.next(20000);
    assert.equal(response.result.isError, true);
    assert.match(response.result.content[0].text, /baseline/i);
    assert.ok(!response.result.content[0].text.includes("{not json"));

    server.send({ jsonrpc: "2.0", id: 61, method: "ping" });
    assert.equal((await server.next()).id, 61);
  } finally {
    server.child.kill();
    await rm(root, { recursive: true, force: true });
  }
});

test("tools/call returns structured coverage and concurrent calls stay ordered", async () => {
  const server = startServer();
  const root = await fakeProject();
  try {
    server.send({
      jsonrpc: "2.0", id: 50, method: "tools/call",
      params: { name: "kkomkkom", arguments: { projectPath: root, fast: true } },
    });
    const response = await server.next(20000);
    assert.equal(response.id, 50);
    assert.equal(response.result.structuredContent.schemaVersion, 2);
    assert.equal(response.result.structuredContent.coverage.status, "complete");
    assert.ok(Array.isArray(response.result.structuredContent.extra));

    server.send({ jsonrpc: "2.0", id: 51, method: "tools/call",
      params: { name: "kkomkkom", arguments: { fast: "bad" } } });
    server.send({ jsonrpc: "2.0", id: 52, method: "tools/call",
      params: { name: "kkomkkom", arguments: { strict: "bad" } } });
    const first = await server.next();
    const second = await server.next();
    assert.deepEqual([first.id, second.id], [51, 52]);
    assert.equal(first.result.isError, true);
    assert.equal(second.result.isError, true);
  } finally {
    server.child.kill();
    await rm(root, { recursive: true, force: true });
  }
});
