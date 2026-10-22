import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { auditProject, redactSecrets } from "../dist/audit.js";

const exec = promisify(execFile);
const fakeKey = "sk_live_" + "FAKE0123456789".repeat(3);

async function fixture(t, files = {}, git = false) {
  const root = await mkdtemp(join(tmpdir(), "kkomkkom-audit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), content);
  }
  if (git) await exec("git", ["-C", root, "init", "-q"]);
  return root;
}

function input(root, routes = [], config = {}, baseUrl = "http://127.0.0.1:1") {
  return {
    root, baseUrl, routes,
    config: { ignoreRoutes: [], sampleParams: {}, port: 3100,
      thresholds: { jsPercent: 15, jsBytes: 30000 }, ...config },
  };
}

function route(path, source = "", kind = "api", dynamic = false, file = "", router = "app") {
  return { path, source, kind, dynamic, file, router };
}

async function serve(t, handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  }));
  return `http://127.0.0.1:${server.address().port}`;
}

test("tracked .env is critical without a duplicate not-ignored warning", async (t) => {
  const root = await fixture(t, { ".env": "VALUE=hidden" }, true);
  for (const [key, value] of [["user.email", "audit@example.invalid"], ["user.name", "Audit Test"]]) {
    await exec("git", ["-C", root, "config", key, value]);
  }
  await exec("git", ["-C", root, "add", ".env"]);
  await exec("git", ["-C", root, "-c", "core.hooksPath=/dev/null", "commit", "-qm", "fixture"]);
  assert.deepEqual(await auditProject(input(root)), [{
    id: "env-tracked:.env", severity: "critical", messageKey: "extraEnvTracked", messageVars: { file: ".env" },
  }]);
});

test("untracked non-ignored .env.local warns", async (t) => {
  const root = await fixture(t, { ".env.local": "VALUE=hidden" }, true);
  assert.deepEqual(await auditProject(input(root)), [{
    id: "env-not-ignored:.env.local", severity: "warning", messageKey: "extraEnvNotIgnored",
    messageVars: { file: ".env.local" },
  }]);
});

test("tracked .env symlink is checked and its secret names are parsed", { skip: process.platform === "win32" }, async (t) => {
  const root = await fixture(t, { "secrets.txt": "NEXT_PUBLIC_API_SECRET=real-value" }, true);
  await symlink("secrets.txt", join(root, ".env"));
  await exec("git", ["-C", root, "add", ".env"]);
  const findings = await auditProject(input(root));
  assert.deepEqual(findings.map((f) => f.id), ["env-tracked:.env", "public-secret:NEXT_PUBLIC_API_SECRET"]);
  assert.ok(!JSON.stringify(findings).includes("real-value"));
});

test("ignored .env.local has no git finding", async (t) => {
  const root = await fixture(t, { ".env.local": "VALUE=hidden", ".gitignore": ".env*\n" }, true);
  assert.deepEqual(await auditProject(input(root)), []);
});

test("public secret name warns without exposing its value", async (t) => {
  const root = await fixture(t, { ".env": "NEXT_PUBLIC_API_SECRET=real-value" });
  const findings = await auditProject(input(root));
  assert.deepEqual(findings, [{ id: "public-secret:NEXT_PUBLIC_API_SECRET", severity: "warning",
    messageKey: "extraPublicSecret", messageVars: { key: "NEXT_PUBLIC_API_SECRET" } }]);
  assert.ok(!JSON.stringify(findings).includes("real-value"));
});

test("public API URL is not a secret name", async (t) => {
  const root = await fixture(t, { ".env": "NEXT_PUBLIC_API_URL=https://example.com\nNEXT_PUBLIC_COMPASS=public" });
  assert.deepEqual(await auditProject(input(root)), []);
});

test("env parsing handles export, quotes, comments, placeholders and duplicate keys", async (t) => {
  const root = await fixture(t, {
    ".env": ' # NEXT_PUBLIC_TOKEN=commented\n export NEXT_PUBLIC_API_SECRET = "real#value" # comment\nNEXT_PUBLIC_PASSWORD=\'\'\nNEXT_PUBLIC_TOKEN=your-token\nNEXT_PUBLIC_PRIVATE= # empty\n',
    ".env.local": 'NEXT_PUBLIC_API_SECRET=another-value\nNEXT_PUBLIC_ACCESS_KEY=valid-value # comment',
    ".env.example": "NEXT_PUBLIC_BAD_SECRET=real-value",
    ".env.sample": "NEXT_PUBLIC_BAD_TOKEN=real-value",
    ".env.template": "NEXT_PUBLIC_BAD_PASSWORD=real-value",
    ".env.local.example": "NEXT_PUBLIC_ALSO_BAD_SECRET=real-value",
    "nested/.env": "NEXT_PUBLIC_NESTED_SECRET=real-value",
  });
  assert.deepEqual((await auditProject(input(root))).map((f) => f.id), [
    "public-secret:NEXT_PUBLIC_ACCESS_KEY", "public-secret:NEXT_PUBLIC_API_SECRET",
  ]);
});

test("an unreadable source file is failed coverage and the scan continues", { skip: process.platform === "win32" || process.getuid?.() === 0 }, async (t) => {
  const root = await fixture(t, {
    "lib/open.ts": `const key = '${fakeKey}';`,
    "lib/private.ts": `const key = '${fakeKey}';`,
  });
  const locked = join(root, "lib", "private.ts");
  await chmod(locked, 0o000);
  const coverage = [];
  const findings = await auditProject(input(root), coverage);
  assert.deepEqual(findings.map((finding) => finding.id), ["hardcoded-secret:lib/open.ts:1"]);
  assert.deepEqual(coverage, [{
    rule: "secrets", path: "lib/private.ts", status: "failed", reason: "read",
  }]);
  assert.ok(!JSON.stringify(coverage).includes(fakeKey));
});

test("an unreadable source directory is failed coverage, not an empty scan", { skip: process.platform === "win32" || process.getuid?.() === 0 }, async (t) => {
  const root = await fixture(t, { "lib/locked/secret.ts": `const key = '${fakeKey}';` });
  const locked = join(root, "lib", "locked");
  await chmod(locked, 0o000);
  const coverage = [];
  let findings;
  try {
    findings = await auditProject(input(root), coverage);
  } finally {
    await chmod(locked, 0o755).catch(() => {});
  }
  assert.deepEqual(findings, []);
  assert.deepEqual(coverage, [{
    rule: "secrets", path: "lib/locked", status: "failed", reason: "read",
  }]);
});

test("an unreadable .env is failed coverage without exposing its value", { skip: process.platform === "win32" || process.getuid?.() === 0 }, async (t) => {
  const root = await fixture(t, { ".env": `NEXT_PUBLIC_API_SECRET=${fakeKey}` });
  await chmod(join(root, ".env"), 0o000);
  const coverage = [];
  const findings = await auditProject(input(root), coverage);
  assert.deepEqual(findings, []);
  assert.deepEqual(coverage, [{
    rule: "secrets", path: ".env", status: "failed", reason: "read",
  }]);
  assert.ok(!JSON.stringify(coverage).includes(fakeKey));
});

test("hardcoded key is critical with only its relative file and line", async (t) => {
  const root = await fixture(t, { "src/lib/x.ts": `// fixture\nconst key = '${fakeKey}';` });
  const findings = await auditProject(input(root));
  assert.deepEqual(findings, [{ id: "hardcoded-secret:src/lib/x.ts:2", severity: "critical",
    messageKey: "extraHardcodedSecret", messageVars: { file: "src/lib/x.ts", line: 2 } }]);
  assert.ok(!JSON.stringify(findings).includes(fakeKey));
});

test("all high-confidence patterns are detected once per file line", async (t) => {
  const values = [fakeKey, "sk-proj-" + "FAKE0123456789_".repeat(3), "AKIA" + "FAKE0123456789ABC",
    "ghp_" + "FAKE01234567".repeat(3), "xoxb-FAKE-0123456789",
    "-----BEGIN PRIVATE KEY-----", "-----BEGIN RSA PRIVATE KEY-----",
    "-----BEGIN EC PRIVATE KEY-----", "-----BEGIN OPENSSH PRIVATE KEY-----"];
  const root = await fixture(t, { "lib/keys.cjs": values.map((v) => `${v} ${v}`).join("\n") });
  const findings = await auditProject(input(root));
  assert.equal(findings.length, 9);
  assert.deepEqual(new Set(findings.map((f) => f.messageVars.line)), new Set([1,2,3,4,5,6,7,8,9]));
  for (const value of values) assert.ok(!JSON.stringify(findings).includes(value));
});

test("source scans skip placeholders, excluded directories, non-source and symlinks", async (t) => {
  const root = await fixture(t, {
    "src/keys.ts": 'const key="sk_live_' + "example".repeat(5) + '";',
    "src/fixtures/leak.ts": fakeKey, "src/test/leak.ts": fakeKey,
    "src/node_modules/leak.js": fakeKey, "src/.next/leak.js": fakeKey,
    "src/readme.md": fakeKey, "other/leak.ts": fakeKey,
  });
  await symlink(join(root, "other"), join(root, "src", "linked"),
    process.platform === "win32" ? "junction" : "dir");
  assert.deepEqual(await auditProject(input(root)), []);
});

test("root config and middleware sources are scanned", async (t) => {
  const root = await fixture(t, { "next.config.mjs": fakeKey, "middleware.ts": fakeKey });
  assert.deepEqual((await auditProject(input(root))).map((f) => f.id), [
    "hardcoded-secret:middleware.ts:1", "hardcoded-secret:next.config.mjs:1",
  ]);
});

const appWriteCases = [
  ["POST", "export async function POST() {}"],
  ["PUT", "export function PUT() {}"],
  ["PATCH", "export const PATCH = () => {}"],
  ["DELETE", "export let DELETE = () => {}"],
  ["POST", "function handler() {}\nexport { handler as POST }"],
];
const pagesWriteCases = [
  ["POST", 'export default function handler(req, res) { if (req.method === "POST") {} }'],
  ["PATCH", "export default function handler(req, res) { if (request.method == 'PATCH') {} }"],
  ["DELETE", 'export default function handler(req, res) { switch (req.method) { case "DELETE": break; } }'],
];

for (const [method, source] of appWriteCases) {
  test(`app write API without auth warns: ${source}`, async (t) => {
    const root = await fixture(t);
    assert.deepEqual(await auditProject(input(root, [
      route("/api/orders", source, "api", false, "app/api/orders/route.ts", "app"),
    ])), [{
      id: `write-no-auth:/api/orders:${method}`, severity: "warning", messageKey: "extraWriteNoAuth",
      messageVars: { path: "/api/orders", method }, evidence: [{ method, auth: "none" }],
    }]);
  });
}

for (const [method, source] of pagesWriteCases) {
  test(`pages write API without auth warns: ${source}`, async (t) => {
    const root = await fixture(t);
    assert.deepEqual(await auditProject(input(root, [
      route("/api/orders", source, "api", false, "pages/api/orders.ts", "pages"),
    ])), [{
      id: `write-no-auth:/api/orders:${method}`, severity: "warning", messageKey: "extraWriteNoAuth",
      messageVars: { path: "/api/orders", method }, evidence: [{ method, auth: "none" }],
    }]);
  });
}

test("write API with auth(), GET-only and ignored writes do not warn", async (t) => {
  const root = await fixture(t);
  assert.deepEqual(await auditProject(input(root, [
    route("/api/authenticated", "export async function POST(){ auth() }"),
    route("/api/read", "export function GET() {}"),
    route("/api/webhooks/event", "export const POST = handler"),
  ], { ignoreRoutes: ["/api/webhooks/*"] })), []);
});

test("write auth is not shared between methods", async (t) => {
  const root = await fixture(t);
  assert.deepEqual(await auditProject(input(root, [
    route("/api/get-auth", "export function GET(){ auth() }\nexport function POST() {}"),
    route("/api/post-auth", "export function GET() {}\nexport function POST(){ auth() }"),
  ])), [{
    id: "write-no-auth:/api/get-auth:POST", severity: "warning", messageKey: "extraWriteNoAuth",
    messageVars: { path: "/api/get-auth", method: "POST" },
    evidence: [{ method: "POST", auth: "none" }],
  }]);
});

test("wrapper, re-export and uncalled nested auth stay unknown instead of confirmed no-auth", async (t) => {
  const root = await fixture(t);
  assert.deepEqual((await auditProject(input(root, [
    route("/api/wrapper", "export const POST = withAuth(handler)"),
    route("/api/reexport", 'export { POST } from "./other"'),
    route("/api/nested", "export function POST(){ function inner(){ auth() } }"),
    route("/api/ambiguous", 'export default function handler(req, res) { return res.end("ok") }',
      "api", false, "/project/pages/api/ambiguous.ts", "pages"),
  ]))).map((finding) => finding.id), [
    "write-unknown:/api/nested",
    "write-unknown:/api/reexport",
    "write-unknown:/api/wrapper",
    "write-unsupported:/api/ambiguous",
  ]);
});

test("an uninterpretable pages handler is unsupported coverage, not a hidden or fake method list", async (t) => {
  const root = await fixture(t);
  const coverage = [];
  const findings = await auditProject(input(root, [
    route("/api/opaque", "export default handler", "api", false, "pages/api/opaque.ts", "pages"),
  ]), coverage);
  assert.deepEqual(findings, [{
    id: "write-unsupported:/api/opaque", severity: "info", messageKey: "extraWriteUnsupported",
    messageVars: { path: "/api/opaque" },
  }]);
  assert.deepEqual(coverage.filter((check) => check.rule === "write-auth"), [
    { rule: "write-auth", path: "/api/opaque", status: "unsupported", reason: "unsupported-handler" },
  ]);
});

test("an explicit public write policy is not a warning and keeps static evidence", async (t) => {
  const root = await fixture(t);
  const coverage = [];
  const findings = await auditProject(input(root, [
    route("/api/public", "export function POST() {}\nexport function PUT() {}"),
  ], { routePolicies: { "/api/public": { POST: "public" } } }), coverage);
  assert.deepEqual(findings, [{
    id: "write-no-auth:/api/public:PUT", severity: "warning", messageKey: "extraWriteNoAuth",
    messageVars: { path: "/api/public", method: "PUT" },
    evidence: [{ method: "PUT", auth: "none" }],
  }]);
  assert.deepEqual(coverage.filter((check) => check.rule === "write-auth"), [
    { rule: "write-auth", path: "/api/public", method: "POST", status: "static-only", reason: "explicit-public" },
    { rule: "write-auth", path: "/api/public", method: "PUT", status: "static-only", reason: "none" },
  ]);
});

test("comments do not create or hide write APIs", async (t) => {
  const root = await fixture(t);
  assert.deepEqual(await auditProject(input(root, [
    route("/api/comment-only", "// export { POST }\nexport function GET() {}"),
    route("/api/hidden-write", "// auth()\nexport function POST() {}"),
  ])), [{
    id: "write-no-auth:/api/hidden-write:POST", severity: "warning", messageKey: "extraWriteNoAuth",
    messageVars: { path: "/api/hidden-write", method: "POST" },
    evidence: [{ method: "POST", auth: "none" }],
  }]);
});

test("regex literals do not turn comments into auth", async (t) => {
  const root = await fixture(t);
  assert.deepEqual(await auditProject(input(root, [
    route("/api/if-regex-comment", 'if (ok) /"/; // auth()\nexport function POST() {}'),
    route("/api/method-division-comment", 'const half = await Promise.resolve(4).catch(() => 0) / 2; // auth()\nexport function POST() {}'),
    route("/api/regex-comment", 'const quote = /"/; // auth()\nexport function POST() {}'),
  ])), [{
    id: "write-no-auth:/api/if-regex-comment:POST", severity: "warning", messageKey: "extraWriteNoAuth",
    messageVars: { path: "/api/if-regex-comment", method: "POST" },
    evidence: [{ method: "POST", auth: "none" }],
  }, {
    id: "write-no-auth:/api/method-division-comment:POST", severity: "warning", messageKey: "extraWriteNoAuth",
    messageVars: { path: "/api/method-division-comment", method: "POST" },
    evidence: [{ method: "POST", auth: "none" }],
  }, {
    id: "write-no-auth:/api/regex-comment:POST", severity: "warning", messageKey: "extraWriteNoAuth",
    messageVars: { path: "/api/regex-comment", method: "POST" },
    evidence: [{ method: "POST", auth: "none" }],
  }]);
});

test("arrow function regexes do not turn comments into auth", async (t) => {
  const root = await fixture(t);
  assert.deepEqual(await auditProject(input(root, [
    route("/api/arrow-regex-comment", 'const quote = () => /"/; // auth()\nexport function POST() {}'),
  ])), [{
    id: "write-no-auth:/api/arrow-regex-comment:POST", severity: "warning", messageKey: "extraWriteNoAuth",
    messageVars: { path: "/api/arrow-regex-comment", method: "POST" },
    evidence: [{ method: "POST", auth: "none" }],
  }]);
});

test("whitespace or comments around a method name do not break division", async (t) => {
  const root = await fixture(t);
  const source = (separator) =>
    `const half = await Promise.resolve(4).${separator}catch(() => 0) / 2; // auth()\nexport function POST() {}`;
  const findings = await auditProject(input(root, [
    route("/api/space", source(" ")),
    route("/api/comment", source(" /* fallback */ ")),
  ]));
  assert.deepEqual(findings.map((finding) => finding.id), [
    "write-no-auth:/api/comment:POST",
    "write-no-auth:/api/space:POST",
  ]);
});

test("redactSecrets hides env values and high-confidence keys", async (t) => {
  const root = await fixture(t, {
    ".env": "API_TOKEN=super-secret-value",
    ".env.local": "OTHER_TOKEN=another-secret-value",
  });
  const out = await redactSecrets(root, `failed: API_TOKEN=super-secret-value ${fakeKey} OTHER_TOKEN=another-secret-value`);
  assert.ok(!out.includes("super-secret-value"));
  assert.ok(!out.includes("another-secret-value"));
  assert.ok(!out.includes(fakeKey));
  assert.match(out, /\[redacted\]/);
});

test("redactSecrets removes a whole private key block", async (t) => {
  const root = await fixture(t);
  const text = [
    "failed",
    "-----BEGIN PRIVATE KEY-----",
    "FAKEBODYFAKEBODY",
    "-----END PRIVATE KEY-----",
    "-----BEGIN OPENSSH PRIVATE KEY-----",
    "SSHBODYSSHBODY",
    "-----END OPENSSH PRIVATE KEY-----",
    "-----BEGIN RSA PRIVATE KEY-----",
    "UNCLOSEDBODY",
  ].join("\n");
  const out = await redactSecrets(root, text);
  assert.ok(!out.includes("FAKEBODYFAKEBODY"));
  assert.ok(!out.includes("SSHBODYSSHBODY"));
  assert.ok(!out.includes("UNCLOSEDBODY"));
  assert.match(out, /failed/);
  assert.match(out, /\[redacted\]/);
});

for (const [status, body, expected] of [
  [500, "failure", "extraPageError"], [200, "__next_error__", "extraPageError"],
  [201, "APPLICATION ERROR", "extraPageError"], [200, "Internal Server Error", "extraPageError"],
  [200, "normal page", null], [302, "__next_error__", null], [404, "failure", null],
  [200, "x".repeat(8192) + "__next_error__", null],
]) {
  test(`page smoke ${status}, ${expected ?? "no finding"}, body length ${body.length}`, async (t) => {
    const root = await fixture(t);
    const base = await serve(t, (req, res) => {
      assert.equal(req.method, "GET");
      assert.equal(req.headers.cookie, undefined);
      assert.equal(req.headers.authorization, undefined);
      assert.equal(req.headers["user-agent"], "kkomkkom/0.1");
      res.writeHead(status, { location: "/must-not-follow" });
      res.end(body);
    });
    const findings = await auditProject(input(root, [route("/checkout", "", "page")], {}, base));
    assert.deepEqual(findings, expected ? [{ id: "page-error:/checkout", severity: "warning",
      messageKey: expected, messageVars: { path: "/checkout", status } }] : []);
  });
}

test("page smoke skips ignored and unsampled routes, fills only supported params", async (t) => {
  const root = await fixture(t);
  const seen = [];
  const base = await serve(t, (req, res) => { seen.push(req.url); res.end("OK"); });
  const routes = [route("/ignored", "", "page"), route("/missing/[id]", "", "page", true),
    route("/orders/[id]", "", "page", true), route("/docs/[...slug]", "", "page", true)];
  assert.deepEqual(await auditProject(input(root, routes, { ignoreRoutes: ["/ignored"],
    sampleParams: { "/orders/[id]": { id: "42" }, "/docs/[...slug]": { slug: "a/b" } } }, base)), []);
  assert.deepEqual(seen.sort(), ["/orders/42"]);
});

test("page samples with absent, undefined, empty or dot values never request a fallback path", async (t) => {
  const root = await fixture(t);
  const seen = [];
  const base = await serve(t, (req, res) => { seen.push(req.url); res.end("OK"); });
  const routes = [route("/orders/[id]", "", "page", true)];
  for (const params of [{}, { id: undefined }, { id: "" }, { id: "." }, { id: ".." }]) {
    assert.deepEqual(await auditProject(input(root, routes, {
      sampleParams: { "/orders/[id]": params },
    }, base)), []);
  }
  assert.deepEqual(seen, []);
});

test("page connection failure becomes info, not an exception", async (t) => {
  const root = await fixture(t);
  const base = await serve(t, (req) => req.socket.destroy());
  assert.deepEqual(await auditProject(input(root, [route("/slow", "", "page")], {}, base)), [{
    id: "page-timeout:/slow", severity: "info", messageKey: "extraPageTimeout",
    messageVars: { path: "/slow", seconds: 8 },
  }]);
});

test("page smoke uses five workers and never exceeds five active requests", async (t) => {
  const root = await fixture(t);
  let active = 0, peak = 0, count = 0;
  const base = await serve(t, (_req, res) => {
    active += 1; count += 1; peak = Math.max(peak, active);
    setTimeout(() => { active -= 1; res.end("OK"); }, 30);
  });
  const routes = Array.from({ length: 12 }, (_, i) => route(`/page-${i}`, "", "page"));
  assert.deepEqual(await auditProject(input(root, routes, {}, base)), []);
  assert.equal(count, 12);
  assert.equal(peak, 5);
});

test("findings are deduplicated and sorted by severity then id", async (t) => {
  const root = await fixture(t, { "src/z.ts": fakeKey, ".env": "NEXT_PUBLIC_TOKEN=real-value" });
  const base = await serve(t, (req) => req.socket.destroy());
  const routes = [route("/z", "export function POST(){}"), route("/a", "export function PUT(){}"),
    route("/z", "export function POST(){}"), route("/slow", "", "page")];
  assert.deepEqual((await auditProject(input(root, routes, {}, base))).map((f) => f.id), [
    "hardcoded-secret:src/z.ts:1", "public-secret:NEXT_PUBLIC_TOKEN", "write-no-auth:/a:PUT",
    "write-no-auth:/z:POST", "page-timeout:/slow",
  ]);
});

test("missing root and unreadable file entries do not throw", async (t) => {
  const root = await fixture(t);
  await mkdir(join(root, ".env.local"));
  assert.deepEqual(await auditProject(input(root)), []);
  assert.deepEqual(await auditProject(input(join(root, "missing"))), []);
});

test("missing git skips only git checks and still detects secret names", async (t) => {
  const root = await fixture(t, { ".env": "NEXT_PUBLIC_API_SECRET=real-value" }, true);
  const moduleUrl = new URL("../dist/audit.js", import.meta.url).href;
  const script = `import { auditProject } from ${JSON.stringify(moduleUrl)};
    const findings = await auditProject(${JSON.stringify(input(root))});
    console.log(JSON.stringify(findings));`;
  const { stdout, stderr } = await exec(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, PATH: root },
  });
  assert.equal(stderr, "");
  assert.ok(!stdout.includes("real-value"));
  assert.deepEqual(JSON.parse(stdout).map((f) => f.id), ["public-secret:NEXT_PUBLIC_API_SECRET"]);
});

test("coverage records page success, exclusion, missing sample, timeout and write uncertainty", async (t) => {
  const root = await fixture(t);
  const base = await serve(t, (req, res) => {
    if (req.url === "/slow") return req.socket.destroy();
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html>ok</html>");
  });
  const coverage = [];
  const routes = [
    route("/ok", "", "page"),
    route("/ignored", "", "page"),
    route("/missing/[id]", "", "page", true),
    route("/slow", "", "page"),
    route("/api/wrapper", "export const POST = withAuth(handler)"),
  ];
  await auditProject(input(root, routes, {
    ignoreRoutes: ["/ignored"],
    sampleParams: {},
  }, base), coverage);

  const page = (path) => coverage.find((check) => check.rule === "page-smoke" && check.path === path);
  assert.deepEqual(page("/ok"), { rule: "page-smoke", path: "/ok", status: "checked", reason: "response" });
  assert.deepEqual(page("/ignored"), { rule: "page-smoke", path: "/ignored", status: "ignored", reason: "ignoreRoutes" });
  assert.deepEqual(page("/missing/[id]"), { rule: "page-smoke", path: "/missing/[id]", status: "failed", reason: "sample-missing" });
  assert.deepEqual(page("/slow"), { rule: "page-smoke", path: "/slow", status: "failed", reason: "timeout" });
  assert.deepEqual(
    coverage.find((check) => check.rule === "write-auth" && check.path === "/api/wrapper"),
    { rule: "write-auth", path: "/api/wrapper", method: "POST", status: "unsupported", reason: "unknown" },
  );
});

test("an explicitly public write is still static-only coverage even when auth is unknown", async (t) => {
  const root = await fixture(t);
  const coverage = [];
  await auditProject(input(root, [
    route("/api/wrapper", "export const POST = withAuth(handler)"),
  ], { routePolicies: { "/api/wrapper": { POST: "public" } } }), coverage);
  assert.deepEqual(coverage.filter((check) => check.rule === "write-auth"), [
    { rule: "write-auth", path: "/api/wrapper", method: "POST", status: "static-only", reason: "explicit-public" },
  ]);
});

test("a page body cut off in transit is failed, not checked", async (t) => {
  const root = await fixture(t);
  const base = await serve(t, (_req, res) => {
    res.writeHead(200, { "content-length": "9999", "content-type": "text/html" });
    res.write("<html>");
    setTimeout(() => res.destroy(), 30);
  });
  const coverage = [];
  const findings = await auditProject(input(root, [route("/cut", "", "page")], {}, base), coverage);
  assert.deepEqual(findings, []);
  assert.deepEqual(coverage.filter((check) => check.rule === "page-smoke"), [
    { rule: "page-smoke", path: "/cut", status: "failed", reason: "body-read" },
  ]);
});
