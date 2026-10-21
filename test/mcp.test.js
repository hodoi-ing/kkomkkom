import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

function startServer() {
  const child = spawn(process.execPath, ["dist/mcp.js"], { stdio: ["pipe", "pipe", "inherit"] });
  const rl = createInterface({ input: child.stdout });
  const messages = [];
  const waiters = [];
  rl.on("line", (line) => {
    const message = JSON.parse(line);
    const waiter = waiters.shift();
    if (waiter) waiter(message);
    else messages.push(message);
  });

  const next = () =>
    new Promise((resolve) => {
      const ready = messages.shift();
      if (ready) return resolve(ready);
      waiters.push(resolve);
    });

  const send = (message) => child.stdin.write(JSON.stringify(message) + "\n");
  return { child, send, next };
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
