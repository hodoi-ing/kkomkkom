import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { startDevServer } from "../dist/server.js";

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

test("reuses a running Next.js server only when asked", async () => {
  await serve('<script src="/_next/static/chunk.js"></script>', async (port) => {
    await assert.rejects(
      () => startDevServer("/tmp", port),
      (error) => error.key === "errPortInUse",
    );
    const server = await startDevServer("/tmp", port, { reuse: true });
    assert.equal(server.owned, false);
    await server.stop();
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
