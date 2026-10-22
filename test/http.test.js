import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readBody } from "../dist/http.js";

async function serve(t, handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  }));
  return `http://127.0.0.1:${server.address().port}`;
}

test("readBody stops at the byte limit", async (t) => {
  const base = await serve(t, (_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("x".repeat(50_000));
  });
  const res = await fetch(base);
  const body = await readBody(res, 1024);
  assert.equal(Buffer.byteLength(body.text), 1024);
  assert.equal(body.truncated, true);
});

test("readBody reports a complete short body as not truncated", async (t) => {
  const base = await serve(t, (_req, res) => res.end("ok"));
  const body = await readBody(await fetch(base), 1024);
  assert.deepEqual(body, { text: "ok", truncated: false });
});

test("readBody rejects a body cut off in transit instead of returning partial text", async (t) => {
  const base = await serve(t, (_req, res) => {
    res.writeHead(200, { "content-length": "9999", "content-type": "text/plain" });
    res.write("partial");
    setTimeout(() => res.destroy(), 30);
  });
  const res = await fetch(base);
  await assert.rejects(() => readBody(res, 8192));
});
