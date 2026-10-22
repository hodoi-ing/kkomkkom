import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeRoute, matchesGlob } from "../dist/classify.js";

function appRoute(source) {
  return { path: "/api/x", file: "/project/app/api/x/route.ts", kind: "api", dynamic: false, source, router: "app" };
}

function pagesRoute(source) {
  return { path: "/api/x", file: "/project/pages/api/x.ts", kind: "api", dynamic: false, source, router: "pages" };
}

function state(route, method) {
  return analyzeRoute(route).methods[method]?.state;
}

test("matchesGlob supports wildcards", () => {
  assert.equal(matchesGlob("/api/webhooks/stripe", "/api/webhooks/*"), true);
  assert.equal(matchesGlob("/api/users", "/api/webhooks/*"), false);
  assert.equal(matchesGlob("/api/health", "/api/health"), true);
});

test("analyzeRoute reads auth evidence per exported app-router method", () => {
  const route = appRoute(`
    export async function GET() { await auth(); return Response.json({}); }
    export async function POST() { return Response.json({}); }
    export const PUT = async () => { const session = await getServerSession(); };
  `);
  assert.equal(state(route, "GET"), "signal");
  assert.equal(state(route, "POST"), "none");
  assert.equal(state(route, "PUT"), "signal");
  assert.equal(state(route, "PATCH"), undefined);
});

test("analyzeRoute ignores strings, comments, regexes and uncalled nested auth", () => {
  const route = appRoute(`
    // await auth()
    const note = "auth()";
    const pattern = /auth\\(/;
    export async function GET() {
      function neverCalled() { return auth(); }
      return Response.json({});
    }
  `);
  assert.notEqual(state(route, "GET"), "signal");
  assert.equal(state(route, "GET"), "unknown");

  const clean = appRoute(`
    const note = "auth()"; // auth()
    export async function GET() { return Response.json({}); }
  `);
  assert.equal(state(clean, "GET"), "none");
});

test("analyzeRoute resolves local export aliases and leaves wrappers unknown", () => {
  const alias = appRoute(`
    async function handler() { await auth(); }
    export { handler as GET };
  `);
  assert.equal(state(alias, "GET"), "signal");

  const reexport = appRoute(`
    export { GET } from "./other";
    export const POST = withAuth(handler);
  `);
  assert.equal(state(reexport, "GET"), "unknown");
  assert.equal(state(reexport, "POST"), "unknown");
});

test("analyzeRoute reads pages/api switch branches without sharing auth", () => {
  const route = pagesRoute(`
    export default async function handler(req, res) {
      switch (req.method) {
        case "GET": {
          await auth();
          return res.end("ok");
        }
        case "POST": {
          return res.end("ok");
        }
      }
    }
  `);
  assert.equal(state(route, "GET"), "signal");
  assert.equal(state(route, "POST"), "none");
});

test("analyzeRoute marks a pages/api common guard or unclear flow unknown", () => {
  const common = pagesRoute(`
    export default async function handler(req, res) {
      const session = await auth();
      if (req.method === "GET") return res.end("ok");
      if (req.method === "POST") return res.end("ok");
    }
  `);
  assert.equal(state(common, "GET"), "unknown");
  assert.equal(state(common, "POST"), "unknown");

  const unclear = pagesRoute(`
    export default async function handler(req, res) {
      return res.end("ok");
    }
  `);
  assert.equal(state(unclear, "GET"), "unknown");
  assert.equal(state(unclear, "POST"), "unknown");
});

test("analyzeRoute reads clear pages/api method comparisons", () => {
  const route = pagesRoute(`
    export default async function handler(req, res) {
      if (req.method === "GET") {
        const session = await auth();
        return res.end("ok");
      }
      if (req.method === "POST") {
        return res.end("ok");
      }
    }
  `);
  assert.equal(state(route, "GET"), "signal");
  assert.equal(state(route, "POST"), "none");
});

test("analyzeRoute uses the discovered router, not a /pages/ substring in the path", () => {
  const route = {
    path: "/api/pages",
    file: "/project/app/api/pages/route.ts",
    kind: "api",
    dynamic: false,
    source: 'export async function POST() { return Response.json({}); }',
    router: "app",
  };
  const result = analyzeRoute(route);
  assert.equal(result.router, "app");
  assert.equal(result.methods.POST?.state, "none");
});
