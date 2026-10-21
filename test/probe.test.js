import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { probeRoutes } from "../dist/probe.js";

function apiRoute(path, source = "", dynamic = false) {
  return { path, file: "", kind: "api", dynamic, source };
}

function config(overrides = {}) {
  return {
    ignoreRoutes: [],
    sampleParams: {},
    port: 3100,
    thresholds: { jsPercent: 15, jsBytes: 30000 },
    ...overrides,
  };
}

async function withServer(run) {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push({ url: req.url, cookie: req.headers.cookie ?? null });
    const json = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };

    const { pathname } = new URL(req.url, "http://127.0.0.1");

    switch (pathname) {
      case "/api/leak":
        return json(200, { email: "a@b.c" });
      case "/api/open":
        return json(200, { ok: true });
      case "/api/secret":
        return json(401, { error: "unauthorized" });
      case "/api/boom":
        return json(500, { error: "boom" });
      case "/api/html-error":
        res.writeHead(200, { "content-type": "text/html" });
        return res.end("<html><body>Application error</body></html>");
      case "/login":
        res.writeHead(200, { "content-type": "text/html" });
        return res.end(
          '<!doctype html><form action="/login" method="post"><input type="password" name="password"></form>',
        );
      case "/api/auth/export":
        return json(200, { privateData: "visible" });
      case "/api/login":
        return json(200, { privateData: "visible" });
      case "/api/start":
        res.writeHead(307, { location: "login" });
        return res.end();
      case "/api/redirect-empty":
        res.writeHead(302);
        return res.end();
      case "/api/redirect-login":
        res.writeHead(302, { location: "/login?next=/api/redirect-login" });
        return res.end();
      case "/api/redirect-data":
        res.writeHead(307, { location: "/api/public" });
        return res.end();
      case "/api/redirect-query":
        res.writeHead(307, { location: "/api/public?token=TOP_SECRET" });
        return res.end();
      case "/api/public":
        return json(200, { ok: true });
      case "/api/redirect-auth-data":
        res.writeHead(307, { location: "/api/auth/export" });
        return res.end();
      case "/api/orders/42":
        return json(200, { id: 42 });
      default:
        return json(404, { error: "not found" });
    }
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    await run(`http://127.0.0.1:${port}`, seen);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("probeRoutes classifies each response", async () => {
  await withServer(async (baseUrl) => {
    const routes = [
      apiRoute("/api/leak", "const user = await auth()"),
      apiRoute("/api/open", "export async function GET() {}"),
      apiRoute("/api/secret", "const user = await auth()"),
      apiRoute("/api/boom", ""),
      apiRoute("/api/html-error", "const user = await auth()"),
      apiRoute("/api/redirect-login"),
      apiRoute("/api/redirect-data"),
      apiRoute("/api/redirect-query"),
      apiRoute("/api/redirect-auth-data"),
      apiRoute("/api/start"),
      apiRoute("/api/redirect-empty"),
      apiRoute("/api/unknown"),
    ];
    const findings = await probeRoutes(baseUrl, routes, config());
    const byPath = Object.fromEntries(findings.map((f) => [f.path, f]));

    assert.equal(byPath["/api/leak"].verdict, "exposed");
    assert.equal(byPath["/api/open"].verdict, "check");
    assert.equal(byPath["/api/secret"].verdict, "locked");
    assert.equal(byPath["/api/boom"].verdict, "error");
    assert.equal(byPath["/api/html-error"].verdict, "error");
    assert.equal(byPath["/api/redirect-login"].verdict, "locked");
    assert.equal(byPath["/api/redirect-login"].detailKey, "detailLockedRedirect");
    assert.equal(byPath["/api/redirect-data"].verdict, "check");
    assert.equal(byPath["/api/redirect-data"].detailKey, "detailRedirect");
    assert.equal(byPath["/api/redirect-query"].verdict, "check");
    assert.equal(byPath["/api/redirect-query"].detailKey, "detailRedirect");
    assert.equal(byPath["/api/redirect-query"].detailVars.location, "/api/public");
    assert.ok(!JSON.stringify(byPath["/api/redirect-query"]).includes("TOP_SECRET"));
    assert.equal(byPath["/api/redirect-auth-data"].verdict, "check");
    assert.equal(byPath["/api/redirect-auth-data"].detailKey, "detailRedirect");
    assert.equal(byPath["/api/start"].verdict, "check");
    assert.equal(byPath["/api/start"].detailKey, "detailRedirect");
    assert.equal(byPath["/api/redirect-empty"].verdict, "check");
    assert.equal(byPath["/api/unknown"].verdict, "unknown");
  });
});

test("probeRoutes never sends cookies", async () => {
  await withServer(async (baseUrl, seen) => {
    await probeRoutes(baseUrl, [apiRoute("/api/open")], config());
    assert.ok(seen.length > 0);
    assert.ok(seen.every((request) => request.cookie === null));
  });
});

test("probeRoutes skips dynamic routes without sample params", async () => {
  await withServer(async (baseUrl, seen) => {
    const findings = await probeRoutes(baseUrl, [apiRoute("/api/orders/[id]", "", true)], config());
    assert.equal(findings[0].verdict, "unknown");
    assert.equal(seen.length, 0);
  });
});

test("probeRoutes uses sample params when configured", async () => {
  await withServer(async (baseUrl) => {
    const route = apiRoute("/api/orders/[id]", "", true);
    const findings = await probeRoutes(baseUrl, [route], config({ sampleParams: { "/api/orders/[id]": { id: "42" } } }));
    assert.equal(findings[0].verdict, "check");
    assert.equal(findings[0].status, 200);
  });
});

test("probeRoutes respects ignoreRoutes", async () => {
  await withServer(async (baseUrl, seen) => {
    const findings = await probeRoutes(baseUrl, [apiRoute("/api/health")], config({ ignoreRoutes: ["/api/health"] }));
    assert.equal(findings[0].verdict, "public");
    assert.equal(seen.length, 0);
  });
});
