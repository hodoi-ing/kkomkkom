import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readBody } from "../dist/http.js";

test("readBody stops at the byte limit", async (t) => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("x".repeat(50_000));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const res = await fetch(`http://127.0.0.1:${server.address().port}`);
  const body = await readBody(res, 1024);
  assert.equal(Buffer.byteLength(body), 1024);
});
