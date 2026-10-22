import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { rangeChangeReason, runArtifactCheck } from "../dist/artifacts.js";
import { CONFIG_LIMIT, loadConfig } from "../dist/config.js";

const SECRET = "sk_live_ABCDEFGHIJKLMNOPQRST";

async function project(t, { files = {}, config, nextConfig, withStatic = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), "kkomkkom-artifacts-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "package.json"), JSON.stringify({
    name: "artifact-fixture",
    dependencies: { next: "16.0.0" },
  }));
  await mkdir(join(root, "node_modules", "next", "dist", "bin"), { recursive: true });
  await writeFile(join(root, "node_modules", "next", "package.json"), JSON.stringify({
    name: "next", version: "16.0.0",
  }));
  const marker = join(root, "build-ran");
  await writeFile(
    join(root, "node_modules", "next", "dist", "bin", "next"),
    `const fs = require("node:fs"); fs.writeFileSync(${JSON.stringify(marker)}, "ran");`,
  );
  if (withStatic) {
    await mkdir(join(root, ".next", "static", "chunks"), { recursive: true });
    await writeFile(join(root, ".next", "BUILD_ID"), "fixture-build");
    await writeFile(join(root, ".next", "static", "chunks", "app.js"), "console.log('app');\n");
  }
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  if (config !== undefined) {
    await writeFile(join(root, "kkomkkom.config.json"), JSON.stringify(config));
  }
  if (nextConfig !== undefined) {
    await writeFile(join(root, "next.config.mjs"), nextConfig);
  }
  return { root, marker };
}

function byRule(result, rule) {
  return result.extras.filter((extra) => extra.rule === rule);
}

function coverageReasons(result, status) {
  return result.coverage.checks
    .filter((check) => check.status === status)
    .map((check) => check.reason ?? "");
}

test("normal public files, public keys, examples and server-only output stay clean", async (t) => {
  const { root } = await project(t, {
    files: {
      "public/robots.txt": "User-agent: *\nAllow: /\n",
      "public/logo.svg": "<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>",
      "public/.well-known/security.txt": "Contact: mailto:security@example.com\n",
      "public/.env.example": "NEXT_PUBLIC_STRIPE_KEY=pk_live_EXAMPLE\nDEMO_SECRET=sk_live_example000000000000\n",
      ".next/static/chunks/page.js": "const key = 'NEXT_PUBLIC_STRIPE_KEY'; // pk_live_public\n",
      ".next/server/app/page.js.map": `{"sources":["x"],"secret":"${SECRET}"}`,
      "app/page.test.tsx": "export default function Page() { return null; }\n",
      "app/widget.tsx": "\"use client\";\nimport Link from \"next/link\";\nimport { useState } from \"react\";\nexport function Widget() { return <Link href=\"/\">{useState(1)[0]}</Link>; }\n",
      "app/server-page.tsx": "import \"server-only\";\nexport default function Page() { return null; }\n",
    },
    nextConfig: "export default { productionBrowserSourceMaps: false };\n",
  });

  const result = await runArtifactCheck({ root, strict: false });
  assert.equal(result.extras.length, 0);
  assert.equal(result.exitCode, 0);
  assert.equal(result.coverage.status, "complete");
  assert.ok(!JSON.stringify(result).includes(SECRET));
});

test("defect fixture reports all four artifact rules without leaking values", async (t) => {
  const { root, marker } = await project(t, {
    files: {
      "public/source.js.map": `{"version":3,"sources":["app.ts"],"mappings":"AAAA","secret":"${SECRET}"}`,
      "public/.env": `DATABASE_PASSWORD=${SECRET}\n`,
      "public/backup.sql": "select 1;\n",
      "public/debug.log": "request failed\n",
      ".next/static/chunks/app.js":
        `const k = "${SECRET}";\n//# sourceMappingURL=app.js.map\n`,
      "app/widget.tsx":
        "\"use client\";\nimport { data } from \"./server-thing\";\nexport function Widget() { return data; }\n",
      "app/server-thing.ts": "import \"server-only\";\nexport const data = 1;\n",
    },
    nextConfig: "export default { productionBrowserSourceMaps: true };\n",
  });

  const result = await runArtifactCheck({ root, strict: false });
  const maps = byRule(result, "artifact-source-map");
  const sensitive = byRule(result, "artifact-sensitive-file");
  const secrets = byRule(result, "artifact-client-secret");
  const boundary = byRule(result, "artifact-server-boundary");

  assert.ok(maps.some((item) => item.file === "public/source.js.map"));
  assert.ok(maps.some((item) => item.file === ".next/static/chunks/app.js"));
  assert.ok(maps.some((item) => item.file === "next.config.mjs" && item.evidenceKind === "configuration"));
  assert.ok(sensitive.some((item) => item.file === "public/.env" && item.severity === "critical"));
  assert.ok(sensitive.some((item) => item.file === "public/backup.sql" && item.severity === "warning"));
  assert.ok(sensitive.some((item) => item.file === "public/debug.log"));
  assert.ok(secrets.some((item) => item.file === ".next/static/chunks/app.js" && item.confidence === "confirmed"));
  assert.ok(boundary.some((item) => item.file === "app/widget.tsx" && item.evidenceKind === "source-import"));

  assert.equal(result.exitCode, 1);
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes(SECRET));
  assert.ok(!serialized.includes("verysecretvalue123"));
  assert.equal(await readFile(marker, "utf8").catch(() => null), null);
});

test("config setting without a produced map is configuration evidence only", async (t) => {
  const { root } = await project(t, {
    nextConfig: "export default { productionBrowserSourceMaps: true };\n",
  });
  const result = await runArtifactCheck({ root, strict: false });
  const map = byRule(result, "artifact-source-map");
  assert.equal(map.length, 1);
  assert.equal(map[0].file, "next.config.mjs");
  assert.equal(map[0].evidenceKind, "configuration");
  assert.equal(map[0].confidence, "confirmed");
  assert.equal(map[0].severity, "warning");
  assert.equal(result.exitCode, 0);
});

test("unresolved config and unsupported output are visible, never a clean success", async (t) => {
  const cases = [
    {
      name: "computed source map setting",
      nextConfig: "export default { productionBrowserSourceMaps: process.env.MAPS === \"1\" };\n",
      reason: "config-unresolved",
    },
    { name: "custom distDir", nextConfig: "export default { distDir: \"build\" };\n", reason: "custom-distDir" },
    { name: "static export", nextConfig: "export default { output: \"export\" };\n", reason: "output-export" },
    { name: "standalone", nextConfig: "export default { output: \"standalone\" };\n", reason: "output-standalone" },
  ];
  for (const item of cases) {
    const { root } = await project(t, { nextConfig: item.nextConfig });
    const result = await runArtifactCheck({ root, strict: false });
    assert.equal(result.exitCode, 0, item.name);
    assert.equal(result.coverage.status, "incomplete", item.name);
    assert.ok(coverageReasons(result, "unsupported").includes(item.reason), item.name);
    assert.equal(byRule(result, "artifact-source-map").length, 0, item.name);
  }
});

test("missing output is explicit and strict fails", async (t) => {
  const { root } = await project(t, { withStatic: false });
  const loose = await runArtifactCheck({ root, strict: false });
  assert.equal(loose.coverage.status, "incomplete");
  assert.ok(coverageReasons(loose, "unsupported").includes("missing-output"));
  assert.equal(loose.exitCode, 0);

  const strict = await runArtifactCheck({ root, strict: true });
  assert.equal(strict.exitCode, 1);
});

test("build freshness is not asserted from the presence of .next", async (t) => {
  const { root } = await project(t);
  const result = await runArtifactCheck({ root, strict: false });
  assert.ok(coverageReasons(result, "static-only").includes("build-freshness-unknown"));
  assert.ok(coverageReasons(result, "static-only").includes("build-id-present"));
  assert.equal(result.diff.firstRun, false);
});

test("dynamic and alias imports stay unverified while external imports are ignored", async (t) => {
  const { root } = await project(t, {
    files: {
      "app/alias.tsx": "\"use client\";\nimport { x } from \"@/lib/x\";\nexport function A() { return x; }\n",
      "app/dynamic.tsx": "\"use client\";\nexport function D() { return import(\"./later\"); }\n",
      "app/external.tsx": "\"use client\";\nimport React from \"react\";\nimport { thing } from \"some-library\";\nexport function E() { return React.createElement(\"i\", null, thing); }\n",
      "app/later.ts": "export const later = 1;\n",
    },
  });
  const result = await runArtifactCheck({ root, strict: false });
  const unsupported = coverageReasons(result, "unsupported");
  assert.ok(unsupported.includes("alias-import"));
  assert.ok(unsupported.includes("dynamic-import"));
  assert.equal(result.coverage.status, "incomplete");
});

test("type-only imports and exports are not runtime server-only evidence", async (t) => {
  const { root } = await project(t, {
    files: {
      "app/type-entry.tsx":
        "\"use client\";\nimport type { Foo } from \"./server\";\nexport function A() { return null; }\n",
      "app/named-entry.tsx":
        "\"use client\";\nimport { type Foo } from \"./server\";\nexport function B() { return null; }\n",
      "app/export-entry.tsx":
        "\"use client\";\nexport type { Foo } from \"./server\";\nexport function C() { return null; }\n",
      "app/mixed-entry.tsx":
        "\"use client\";\nimport { type Foo, data } from \"./server-mixed\";\nexport function D() { return data; }\n",
      "app/server.ts": "import \"server-only\";\nexport interface Foo { x: number }\n",
      "app/server-mixed.ts": "import \"server-only\";\nexport const data = 1;\nexport interface Foo { x: number }\n",
    },
  });
  const result = await runArtifactCheck({ root, strict: false });
  const boundary = byRule(result, "artifact-server-boundary");
  assert.equal(boundary.length, 1);
  assert.equal(boundary[0].file, "app/mixed-entry.tsx");
});

test("a default runtime binding keeps type-only named imports as runtime evidence", async (t) => {
  const { root } = await project(t, {
    files: {
      "app/client.tsx": "\"use client\";\nimport Foo, { type Bar } from \"../lib/server\";\nexport default () => Foo;\n",
      "lib/server.ts": "import \"server-only\";\nexport default function Foo() {}\nexport type Bar = number;\n",
    },
  });
  const result = await runArtifactCheck({ root, strict: false });
  const boundary = byRule(result, "artifact-server-boundary");
  assert.equal(boundary.length, 1);
  assert.equal(boundary[0].file, "app/client.tsx");
  assert.equal(boundary[0].messageVars.target, "lib/server.ts");
});

test("comments and strings do not create server-only or map findings", async (t) => {
  const { root } = await project(t, {
    files: {
      "app/comment-entry.tsx":
        "\"use client\";\n// import \"server-only\"\nconst text = 'import \"server-only\"';\nexport function E() { return text; }\n",
      "public/app.js":
        "const docs = \"sourceMappingURL=data:text/plain,bogus\";\n//# sourceMappingURL=missing.map\n",
    },
  });
  const result = await runArtifactCheck({ root, strict: false });
  assert.equal(byRule(result, "artifact-server-boundary").length, 0);
  assert.equal(byRule(result, "artifact-source-map").filter((item) => item.file === "public/app.js").length, 1);
  assert.equal(byRule(result, "artifact-source-map").find((item) => item.file === "public/app.js").messageKey,
    "artifactSourceMapReference");
});

test("a sensitive server env value found in a client artifact is a value-free warning", async (t) => {
  const value = "ordinary-private-token-abcdef123456";
  const publicValue = "https://api.example.com/v1";
  const version = "1.2.3";
  const { root } = await project(t, {
    files: {
      ".env": `PRIVATE_TOKEN=${value}\nNEXT_PUBLIC_API_URL=${publicValue}\nAPP_VERSION=${version}\nEXAMPLE_TOKEN=example-placeholder-token\n`,
      ".next/static/chunks/bundle.js":
        `const a = "${value}";\nconst b = "${publicValue}";\nconst c = "${version}";\n`,
      "app/page.tsx": "export default function Page() { return null; }\n",
    },
  });
  const result = await runArtifactCheck({ root, strict: false });
  const secrets = byRule(result, "artifact-client-secret");

  assert.equal(secrets.length, 1);
  assert.equal(secrets[0].file, ".next/static/chunks/bundle.js");
  assert.equal(secrets[0].severity, "warning");
  assert.equal(secrets[0].confidence, "uncertain");
  assert.equal(secrets[0].messageKey, "artifactClientEnvValue");
  assert.equal(secrets[0].messageVars.key, "PRIVATE_TOKEN");
  assert.ok(!JSON.stringify(result).includes(value));
  assert.ok(!JSON.stringify(result).includes("example-placeholder-token"));
  assert.equal(result.coverage.status, "complete");
  assert.equal(result.exitCode, 0);
});

test("distinct known env keys in one artifact survive while repeated keys deduplicate", async (t) => {
  const first = ["private", "alpha", "0123456789"].join("-");
  const second = ["private", "beta", "9876543210"].join("-");
  const publicValue = ["public", "token", "0123456789"].join("-");
  const { root } = await project(t, {
    files: {
      ".env": `PRIVATE_TOKEN=${first}\nDB_PASSWORD=${second}\nNEXT_PUBLIC_TOKEN=${publicValue}\nAPP_VERSION=2026.10.22\nSERVICE_URL=https://api.example.com/v1\nEXAMPLE_TOKEN=example-placeholder-token\n`,
      ".env.local": `PRIVATE_TOKEN=${first}\nBACKUP_TOKEN=${first}\n`,
      "app/page.tsx": "export default function Page() { return null; }\n",
      ".next/static/chunks/bundle.js":
        `const values = ${JSON.stringify([first, first, second, publicValue, "2026.10.22", "https://api.example.com/v1", "example-placeholder-token"])};\n`,
    },
  });
  const result = await runArtifactCheck({ root, strict: false });
  const secrets = byRule(result, "artifact-client-secret");

  assert.deepEqual(secrets.map((item) => item.messageVars.key).sort(),
    ["BACKUP_TOKEN", "DB_PASSWORD", "PRIVATE_TOKEN"]);
  assert.equal(new Set(secrets.map((item) => item.id)).size, 3);
  for (const finding of secrets) {
    assert.equal(finding.file, ".next/static/chunks/bundle.js");
    assert.equal(finding.severity, "warning");
    assert.equal(finding.confidence, "uncertain");
    assert.equal(finding.messageKey, "artifactClientEnvValue");
  }
  const output = JSON.stringify(result);
  for (const value of [first, second, publicValue]) assert.ok(!output.includes(value));
  assert.equal(result.coverage.status, "complete");
});

test("runtime server imports reached from a client entry are potential boundary evidence", async (t) => {
  const serverModules = [
    "pg", "mysql2", "@prisma/client", "firebase-admin", "node:fs", "fs",
    "node:child_process", "child_process", "node:net", "net", "@clerk/nextjs/server",
  ];
  const imports = serverModules
    .map((specifier, index) => `import module${index} from "${specifier}";`)
    .join("\n");
  const { root } = await project(t, {
    files: {
      "app/server-imports.tsx":
        `"use client";\n${imports}\nimport { getServerSession } from "next-auth";\nexport default function A() { return getServerSession; }\n`,
      "app/client.tsx":
        "\"use client\";\nimport { db } from \"../lib/db\";\nimport { other } from \"../lib/other\";\nexport function B() { return [db, other]; }\n",
      "lib/db.ts":
        "import { PrismaClient } from \"@prisma/client\";\nexport const db = new PrismaClient();\n",
      "lib/other.ts":
        "import { PrismaClient } from \"@prisma/client\";\nexport const other = new PrismaClient();\n",
      "app/clean.tsx":
        "\"use client\";\nimport React from \"react\";\nimport { useSession } from \"next-auth/react\";\nimport { signIn } from \"next-auth\";\nimport type { PrismaClient } from \"@prisma/client\";\nimport { type Pool } from \"pg\";\nimport type fs from \"node:fs\";\nexport function C() { return [React, useSession, signIn]; }\n",
    },
  });
  const result = await runArtifactCheck({ root, strict: false });
  const boundary = byRule(result, "artifact-server-boundary");
  const direct = boundary.filter((item) => item.file === "app/server-imports.tsx");
  const targets = new Set(direct.map((item) => item.messageVars.target));

  for (const specifier of serverModules) assert.ok(targets.has(specifier), specifier);
  assert.ok(targets.has("next-auth"));
  assert.equal(direct.length, 12);
  assert.equal(new Set(direct.map((item) => item.id)).size, 12);
  assert.equal(direct[0].evidenceKind, "source-import");
  assert.equal(direct[0].confidence, "uncertain");
  assert.equal(direct[0].severity, "warning");
  assert.ok(boundary.some((item) =>
    item.file === "app/client.tsx" && item.messageVars.target === "@prisma/client"));
  assert.equal(boundary.filter((item) => item.file === "app/client.tsx").length, 1);
  assert.equal(boundary.filter((item) => item.file === "app/clean.tsx").length, 0);
  assert.equal(result.exitCode, 0);
});

test("module-level use server stops the client graph while function strings do not", async (t) => {
  const { root } = await project(t, {
    files: {
      "app/client.tsx":
        "\"use client\";\nimport { save } from \"./actions\";\nexport function A() { return save; }\n",
      "app/actions.ts":
        "\"use server\";\nimport pg from \"pg\";\nimport { getServerSession } from \"next-auth\";\nexport async function save() { return [pg, getServerSession]; }\n",
      "app/middle-client.tsx":
        "\"use client\";\nimport { text } from \"./middle\";\nexport function B() { return text; }\n",
      "app/middle.ts":
        "import pg from \"pg\";\nexport function text() { return \"use server\"; }\n",
      "app/both-client.tsx":
        "\"use client\";\nimport { both } from \"./both\";\nexport function C() { return both; }\n",
      "app/both.ts":
        "\"use server\";\n\"use client\";\nimport pg from \"pg\";\nexport const both = pg;\n",
    },
  });
  const result = await runArtifactCheck({ root, strict: false });
  const boundary = byRule(result, "artifact-server-boundary");

  assert.ok(coverageReasons(result, "static-only").includes("server-action-boundary"));
  assert.ok(result.coverage.checks.some((check) =>
    check.status === "static-only" && check.path === "app/actions.ts"));
  assert.ok(coverageReasons(result, "unsupported").includes("conflicting-directives"));
  assert.ok(!boundary.some((item) => item.file === "app/client.tsx"));
  assert.ok(!boundary.some((item) => item.file === "app/both-client.tsx"));
  assert.equal(boundary.length, 1);
  assert.equal(boundary[0].file, "app/middle-client.tsx");
  assert.equal(boundary[0].messageVars.target, "pg");
});

test("dynamic process.env keys stay unverified", async (t) => {
  const { root } = await project(t, {
    files: {
      "app/dynamic-env.tsx":
        "\"use client\";\nconst key = \"PRIVATE_TOKEN\";\nexport function A() { return process.env[key]; }\n",
      "app/static-env.tsx":
        "\"use client\";\nexport function B() { return process.env.NEXT_PUBLIC_API_URL; }\n",
    },
  });
  const result = await runArtifactCheck({ root, strict: false });
  assert.ok(coverageReasons(result, "unsupported").includes("process-env-dynamic"));
  assert.equal(result.extras.length, 0);
});

test("a regex literal that looks like a source map directive is not a comment", async (t) => {
  const { root } = await project(t, {
    files: {
      ".next/static/chunks/re.js": "const re = /[//]sourceMappingURL=foo.map/;\nconsole.log(re);\n",
      ".next/static/chunks/template.js":
        "const text = `//# sourceMappingURL=template.map`;\nconsole.log(text);\n",
    },
  });
  const result = await runArtifactCheck({ root, strict: false });
  assert.equal(byRule(result, "artifact-source-map").filter((item) =>
    item.file === ".next/static/chunks/re.js" || item.file === ".next/static/chunks/template.js").length, 0);
});

test("indexed version 3 source maps are valid map evidence", async (t) => {
  const section = (sourcesContent) => ({
    offset: { line: 0, column: 0 },
    map: { version: 3, sources: ["app.ts"], mappings: "AAAA", ...(sourcesContent ? { sourcesContent: ["x"] } : {}) },
  });
  const { root } = await project(t, {
    files: {
      "public/indexed-content.map": JSON.stringify({ version: 3, sections: [section(true)] }),
      "public/indexed-url.map": JSON.stringify({
        version: 3,
        sections: [{ offset: { line: 0, column: 0 }, url: "chunk.map" }],
      }),
      "public/indexed-bad.map": JSON.stringify({
        version: 3,
        sections: [{ offset: { line: 0 }, map: {} }],
      }),
    },
  });
  const result = await runArtifactCheck({ root, strict: false });
  const maps = byRule(result, "artifact-source-map");
  assert.ok(maps.some((item) => item.file === "public/indexed-content.map"
    && item.messageKey === "artifactSourceMapFileContent"));
  assert.ok(maps.some((item) => item.file === "public/indexed-url.map"
    && item.messageKey === "artifactSourceMapFile"));
  assert.equal(maps.some((item) => item.file === "public/indexed-bad.map"), false);
  assert.ok(coverageReasons(result, "static-only").includes("invalid-map-format"));
});

test("a variable dynamic import is unverified, not silently safe", async (t) => {
  const { root } = await project(t, {
    files: {
      "app/dynamic-variable.tsx":
        "\"use client\";\nconst name = \"./later\";\nexport function D() { return import(name); }\n",
      "app/dynamic-string.tsx":
        "\"use client\";\nexport function S() { return import(\"./later\"); }\n",
      "app/later.ts": "export const later = 1;\n",
    },
  });
  const result = await runArtifactCheck({ root, strict: false });
  const unsupported = coverageReasons(result, "unsupported");
  assert.ok(unsupported.includes("dynamic-import-variable"));
  assert.ok(unsupported.includes("dynamic-import"));
});

test("the source graph refuses relative and symlinked reads outside the project root", { skip: process.platform === "win32" }, async (t) => {
  const outsideDir = await mkdtemp(join(tmpdir(), "kkomkkom-outside-"));
  t.after(() => rm(outsideDir, { recursive: true, force: true }));
  await writeFile(join(outsideDir, "server.ts"), "import \"server-only\";\nexport const x = 1;\n");
  const { root } = await project(t, { withStatic: false });
  await mkdir(join(root, "app"), { recursive: true });
  const specifier = relative(join(root, "app"), join(outsideDir, "server.ts")).split(sep).join("/");
  await writeFile(join(root, "app", "client.tsx"),
    `"use client";\nimport { x } from "${specifier}";\nexport function A() { return x; }\n`);

  const result = await runArtifactCheck({ root, strict: false });
  assert.equal(byRule(result, "artifact-server-boundary").length, 0);
  assert.ok(coverageReasons(result, "unsupported").includes("import-outside"));
  assert.ok(!JSON.stringify(result).includes(outsideDir));

  const linked = await project(t, { withStatic: false });
  const linkedApp = join(outsideDir, "app");
  await mkdir(linkedApp, { recursive: true });
  await writeFile(join(linkedApp, "client.tsx"),
    "\"use client\";\nimport \"server-only\";\nexport function B() { return null; }\n");
  await symlink(linkedApp, join(linked.root, "app"));
  const linkedResult = await runArtifactCheck({ root: linked.root, strict: false });
  assert.equal(byRule(linkedResult, "artifact-server-boundary").length, 0);
  assert.ok(coverageReasons(linkedResult, "unsupported").includes("source-outside"));
});

test("config AST rejects shorthand, wrapper, spread, conditional and computed forms", async (t) => {
  const cases = [
    ["shorthand distDir", "const distDir = \"custom\";\nexport default { distDir };\n", "custom-distDir"],
    ["wrapper", "const make = (x) => x;\nexport default make({ output: \"export\" });\n", "config-wrapper"],
    ["spread", "const base = {};\nexport default { ...base, output: \"export\" };\n", "config-spread"],
    ["conditional", "export default process.env.X ? { output: \"export\" } : {};\n", "config-wrapper"],
    ["module exports shorthand", "const distDir = \"custom\";\nmodule.exports = { distDir };\n", "custom-distDir"],
    ["computed key", "export default { [\"distDir\"]: \"custom\" };\n", "config-unresolved"],
  ];
  for (const [name, nextConfig, reason] of cases) {
    const { root } = await project(t, { nextConfig });
    const result = await runArtifactCheck({ root, strict: false });
    assert.equal(result.exitCode, 0, name);
    assert.equal(result.coverage.status, "incomplete", name);
    assert.ok(coverageReasons(result, "unsupported").includes(reason), name);
  }

  for (const nextConfig of [
    "// output: \"export\"\nexport default {};\n",
    "const note = 'output: \"export\"';\nexport default {};\n",
  ]) {
    const { root } = await project(t, { nextConfig });
    const result = await runArtifactCheck({ root, strict: false });
    assert.equal(result.exitCode, 0);
    assert.ok(!coverageReasons(result, "unsupported").includes("output-export"));
  }
});

test("source map files need a valid map format and stay warning-level", async (t) => {
  const valid = JSON.stringify({ version: 3, sources: ["app.ts"], mappings: "AAAA", sourcesContent: ["const x = 1;"] });
  const validPlain = JSON.stringify({ version: 3, sources: ["app.ts"], mappings: "AAAA" });
  const inline = Buffer.from(valid).toString("base64");
  const { root } = await project(t, {
    files: {
      "public/plain.map": validPlain,
      "public/valid.map": valid,
      "public/invalid.map": "not a map",
      "public/fake.js": "const text = \"sourceMappingURL=data:text/plain,bogus\";\n",
      ".next/static/chunks/inline.js": `//# sourceMappingURL=data:application/json;base64,${inline}\n`,
      ".next/static/chunks/invalid-inline.js": "//# sourceMappingURL=data:text/plain,bogus\n",
    },
  });
  const result = await runArtifactCheck({ root, strict: false });
  const maps = byRule(result, "artifact-source-map");
  assert.equal(maps.length, 3);
  assert.ok(maps.every((item) => item.severity === "warning"));
  assert.ok(maps.some((item) => item.file === "public/plain.map" && item.messageKey === "artifactSourceMapFile"));
  assert.ok(maps.some((item) => item.file === "public/valid.map" && item.messageKey === "artifactSourceMapFileContent"));
  assert.ok(maps.some((item) => item.file === ".next/static/chunks/inline.js" && item.messageKey === "artifactSourceMapInlineContent"));
  assert.equal(maps.some((item) => item.file === "public/invalid.map"), false);
  assert.equal(maps.some((item) => item.file === "public/fake.js"), false);
  assert.equal(maps.some((item) => item.file === ".next/static/chunks/invalid-inline.js"), false);
  assert.ok(coverageReasons(result, "static-only").includes("invalid-map-format"));
  assert.ok(coverageReasons(result, "static-only").includes("invalid-inline-map"));
  assert.equal(result.exitCode, 0);
  assert.ok(!maps.some((item) => /published|reconstruct/i.test(JSON.stringify(item))));
});

test("source-map targets and exception reasons are masked", async (t) => {
  const { root } = await project(t, {
    files: {
      ".next/static/chunks/ref.js": `//# sourceMappingURL=ref.js.map?token=${SECRET}#fragment\n`,
      "public/userinfo.js": "//# sourceMappingURL=//user:pass@example.com/app.map\n",
      "public/valid.map": JSON.stringify({ version: 3, sources: ["a"], mappings: "AAAA", sourcesContent: ["x"] }),
    },
    config: {
      artifactExceptions: [
        { ruleId: "artifact-source-map", file: "public/valid.map", reason: `demo sk_live_A ${SECRET}?token=${SECRET}` },
      ],
    },
  });
  const result = await runArtifactCheck({ root, strict: false });
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes(SECRET));
  assert.ok(!serialized.includes("sk_live_A"));
  const reference = byRule(result, "artifact-source-map").find((item) => item.file === ".next/static/chunks/ref.js");
  assert.equal(reference.messageVars.target, "ref.js.map");
  const userinfo = byRule(result, "artifact-source-map").find((item) => item.file === "public/userinfo.js");
  assert.equal(userinfo.messageVars.target, "external-target");
  assert.ok(!serialized.includes("user:pass"));
  const ignored = result.coverage.checks.find((check) => check.status === "ignored");
  assert.ok(ignored);
  assert.ok(!ignored.reason.includes(SECRET));
});

test("exception reasons and map targets mask project env secret values", async (t) => {
  const envSecret = "ordinary-env-value-abcdef123456";
  const { root } = await project(t, {
    files: {
      ".env": `PRIVATE_TOKEN=${envSecret}\n`,
      "app/page.tsx": "export default function Page() { return null; }\n",
      "public/valid.map": JSON.stringify({ version: 3, sources: ["a"], mappings: "AAAA", sourcesContent: ["x"] }),
      ".next/static/chunks/ref.js": `//# sourceMappingURL=${envSecret}.map\n`,
    },
    config: {
      artifactExceptions: [
        { ruleId: "artifact-source-map", file: "public/valid.map", reason: `known ${envSecret}` },
      ],
    },
  });
  const result = await runArtifactCheck({ root, strict: false });
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes(envSecret));
  assert.equal(result.coverage.status, "complete");
  const ignored = result.coverage.checks.find((check) => check.status === "ignored");
  assert.ok(ignored);
  assert.match(ignored.reason, /\[redacted\]/);
  const reference = byRule(result, "artifact-source-map").find((item) => item.file === ".next/static/chunks/ref.js");
  assert.equal(reference.messageVars.target, "[redacted].map");

  const cli = runCli(root, ["--artifacts", "--json"]);
  assert.equal(cli.status, 0, cli.stderr);
  assert.ok(!cli.stdout.includes(envSecret));
  assert.ok(!cli.stderr.includes(envSecret));
});

test("an unreadable masking context marks exception reasons unconfirmed", { skip: process.platform === "win32" }, async (t) => {
  const outsideDir = await mkdtemp(join(tmpdir(), "kkomkkom-env-"));
  t.after(() => rm(outsideDir, { recursive: true, force: true }));
  const envSecret = "outside-env-value-abcdef123456";
  await writeFile(join(outsideDir, ".env"), `PRIVATE_TOKEN=${envSecret}\n`);
  const { root } = await project(t, {
    files: {
      "public/valid.map": JSON.stringify({ version: 3, sources: ["a"], mappings: "AAAA", sourcesContent: ["x"] }),
    },
    config: {
      artifactExceptions: [
        { ruleId: "artifact-source-map", file: "public/valid.map", reason: `${envSecret}` },
      ],
    },
  });
  await symlink(join(outsideDir, ".env"), join(root, ".env"));
  const result = await runArtifactCheck({ root, strict: false });
  assert.ok(!JSON.stringify(result).includes(envSecret));
  const ignored = result.coverage.checks.find((check) => check.status === "ignored");
  assert.equal(ignored.reason, "exception:artifact-source-map:unconfirmed");
});

test("sensitive names alone are warnings while high-confidence secret patterns are critical", async (t) => {
  const named = await project(t, {
    files: { "public/.env": "DATABASE_PASSWORD=plainvalue\n" },
  });
  const namedResult = await runArtifactCheck({ root: named.root, strict: false });
  const namedFinding = byRule(namedResult, "artifact-sensitive-file")[0];
  assert.equal(namedFinding.severity, "warning");
  assert.equal(namedFinding.confidence, "uncertain");
  assert.equal(namedResult.exitCode, 0);

  const secret = await project(t, {
    files: { "public/.env": `DATABASE_PASSWORD=${SECRET}\n` },
  });
  const secretResult = await runArtifactCheck({ root: secret.root, strict: false });
  const secretFinding = byRule(secretResult, "artifact-sensitive-file")[0];
  assert.equal(secretFinding.severity, "critical");
  assert.equal(secretFinding.confidence, "confirmed");
  assert.ok(!JSON.stringify(secretResult).includes(SECRET));
});

test("unreadable config, source directory and BUILD_ID are visible failures", { skip: process.getuid?.() === 0 || process.platform === "win32" }, async (t) => {
  const config = await project(t, { nextConfig: "export default {};\n" });
  await chmod(join(config.root, "next.config.mjs"), 0o000);
  const configResult = await runArtifactCheck({ root: config.root, strict: false });
  assert.ok(configResult.coverage.checks.some((check) => check.status === "failed" && check.path === "next.config.mjs"));

  const build = await project(t);
  await chmod(join(build.root, ".next", "BUILD_ID"), 0o000);
  const buildResult = await runArtifactCheck({ root: build.root, strict: false });
  assert.ok(buildResult.coverage.checks.some((check) => check.status === "failed" && check.path === ".next/BUILD_ID"));

  const source = await project(t, {
    files: { "app/client.tsx": "\"use client\";\nexport function A() { return null; }\n" },
  });
  try {
    await chmod(join(source.root, "app"), 0o000);
    const sourceResult = await runArtifactCheck({ root: source.root, strict: false });
    assert.ok(sourceResult.coverage.checks.some((check) => check.status === "failed" && check.path === "app"));
  } finally {
    await chmod(join(source.root, "app"), 0o700);
  }
});

test("oversized source files use the shared file limit", async (t) => {
  const { root } = await project(t, {
    files: { "app/big.tsx": `"use client";\n${"x".repeat(1024 * 1024)}\n` },
  });
  const result = await runArtifactCheck({ root, strict: false });
  assert.ok(coverageReasons(result, "failed").includes("file-size"));
  assert.equal(byRule(result, "artifact-server-boundary").length, 0);
});

test("exact artifact exceptions suppress only that rule and remain visible", async (t) => {
  const { root } = await project(t, {
    files: {
      "public/source.js.map": `{"version":3,"sources":["a"],"mappings":"AAAA","sourcesContent":["const k='${SECRET}'"]}`,
    },
    config: {
      artifactExceptions: [
        { ruleId: "artifact-source-map", file: "public/source.js.map", reason: "intentional demo" },
      ],
    },
  });
  const result = await runArtifactCheck({ root, strict: false });
  assert.equal(byRule(result, "artifact-source-map").length, 0);
  const secret = byRule(result, "artifact-client-secret");
  assert.equal(secret.length, 1);
  assert.equal(secret[0].file, "public/source.js.map");
  assert.equal(result.exitCode, 1);
  const ignored = result.coverage.checks.filter((check) => check.status === "ignored");
  assert.equal(ignored.length, 1);
  assert.equal(ignored[0].path, "public/source.js.map");
  assert.match(ignored[0].reason, /intentional demo/);
});

test("artifact exceptions require a known rule, relative file and reason", async (t) => {
  const invalid = [
    [{ ruleId: "artifact-nope", file: "public/a.map", reason: "x" }, "artifactExceptions[0].ruleId"],
    [{ ruleId: "artifact-source-map", file: "", reason: "x" }, "artifactExceptions[0].file"],
    [{ ruleId: "artifact-source-map", file: "/etc/passwd", reason: "x" }, "artifactExceptions[0].file"],
    [{ ruleId: "artifact-source-map", file: "../x", reason: "x" }, "artifactExceptions[0].file"],
    [{ ruleId: "artifact-source-map", file: "public/a.map", reason: " " }, "artifactExceptions[0].reason"],
    [{ ruleId: "artifact-source-map", file: "public/a.map" }, "artifactExceptions[0].reason"],
  ];
  for (const [entry, field] of invalid) {
    const { root } = await project(t, { config: { artifactExceptions: [entry] } });
    await assert.rejects(
      () => loadConfig(root),
      (error) => error.key === "errConfigField" && error.vars.field === field,
    );
  }
});

test("oversized files and read failures are visible coverage, not silence", async (t) => {
  const { root } = await project(t, {
    files: { "public/large.txt": "x".repeat(1024 * 1024 + 1) },
  });
  const result = await runArtifactCheck({ root, strict: false });
  assert.ok(coverageReasons(result, "failed").includes("file-size"));
});

test("a changed read range is reported instead of silently completed", () => {
  assert.equal(rangeChangeReason(100, 100, 100), null);
  assert.equal(rangeChangeReason(100, 120, 120), "file-grew");
  assert.equal(rangeChangeReason(100, 80, 80), "file-shrunk");
  assert.equal(rangeChangeReason(100, 80, 100), "file-short");
});

test("an oversized or symlinked-out inspection config is an explicit error", { skip: process.platform === "win32" }, async (t) => {
  const large = await project(t, { files: { "public/app.js": "console.log('ok');\n" } });
  await writeFile(join(large.root, "kkomkkom.config.json"),
    `{"artifactExceptions":[]}${" ".repeat(1024 * 1024)}`);
  const before = await readFile(join(large.root, "package.json"), "utf8");
  const largeRun = runCli(large.root, ["--artifacts", "--json"]);
  assert.equal(largeRun.status, 2);
  assert.equal(await readFile(join(large.root, "package.json"), "utf8"), before);

  const outsideDir = await mkdtemp(join(tmpdir(), "kkomkkom-config-"));
  t.after(() => rm(outsideDir, { recursive: true, force: true }));
  await writeFile(join(outsideDir, "kkomkkom.config.json"), "{}");
  const linked = await project(t, { files: { "public/app.js": "console.log('ok');\n" } });
  await symlink(join(outsideDir, "kkomkkom.config.json"), join(linked.root, "kkomkkom.config.json"));
  const linkedRun = runCli(linked.root, ["--artifacts", "--json"]);
  assert.equal(linkedRun.status, 2);
});

test("total read budget and file count limits include a reserved config read", { timeout: 60000 }, async (t) => {
  assert.equal(CONFIG_LIMIT, 1024 * 1024);
  const files = {};
  for (let index = 0; index < 32; index += 1) {
    files[`public/budget-${index}.txt`] = "x".repeat(1024 * 1024);
  }
  const budget = await project(t, { files, withStatic: false });
  const result = await runArtifactCheck({ root: budget.root, strict: false });
  assert.ok(coverageReasons(result, "failed").includes("total-budget"));

  const many = {};
  for (let index = 0; index < 2000; index += 1) many[`public/many-${index}.txt`] = "x";
  const count = await project(t, { files: many, withStatic: false });
  const counted = await runArtifactCheck({ root: count.root, strict: false });
  assert.ok(coverageReasons(counted, "failed").includes("count-limit"));
});

test("unreadable artifact files are recorded as failed coverage", { skip: process.getuid?.() === 0 || process.platform === "win32" }, async (t) => {
  const { root } = await project(t, { files: { "public/unreadable.txt": "data" } });
  await chmod(join(root, "public", "unreadable.txt"), 0o000);
  const result = await runArtifactCheck({ root, strict: false });
  assert.ok(coverageReasons(result, "failed").includes("read"));
});

test("symlink loops are visible failures, not silent skips", { skip: process.platform === "win32" }, async (t) => {
  const { root } = await project(t);
  await mkdir(join(root, "public"), { recursive: true });
  await symlink("loop.txt", join(root, "public", "loop.txt"));
  const artifactResult = await runArtifactCheck({ root, strict: false });
  assert.ok(artifactResult.coverage.checks.some((check) =>
    check.status === "failed" && check.path === "public/loop.txt" && check.reason === "symlink-loop"));

  const config = await project(t, { nextConfig: "export default {};\n" });
  await rm(join(config.root, "next.config.mjs"));
  await symlink("next.config.mjs", join(config.root, "next.config.mjs"));
  const configResult = await runArtifactCheck({ root: config.root, strict: false });
  assert.ok(configResult.coverage.checks.some((check) =>
    check.status === "failed" && check.path === "next.config.mjs" && check.reason === "symlink-loop"));

  const source = await project(t, {
    files: { "app/client.tsx": "\"use client\";\nexport function A() { return null; }\n" },
  });
  await rm(join(source.root, "app", "client.tsx"));
  await symlink("client.tsx", join(source.root, "app", "client.tsx"));
  const sourceResult = await runArtifactCheck({ root: source.root, strict: false });
  assert.ok(sourceResult.coverage.checks.some((check) =>
    check.status === "failed" && check.path === "app/client.tsx" && check.reason === "symlink-loop"));
});

test("a symlink outside the served boundary is refused and its content is not read", { skip: process.platform === "win32" }, async (t) => {
  const { root } = await project(t, { files: { "private/secret.txt": SECRET } });
  await mkdir(join(root, "public"), { recursive: true });
  await symlink(join(root, "private", "secret.txt"), join(root, "public", "leak.txt"));
  const result = await runArtifactCheck({ root, strict: false });
  assert.ok(coverageReasons(result, "unsupported").includes("symlink-escape"));
  assert.ok(!JSON.stringify(result).includes(SECRET));
});

test("a symlink inside the boundary is followed without escaping it", { skip: process.platform === "win32" }, async (t) => {
  const { root } = await project(t, { files: { "public/real.txt": "ok" } });
  await symlink(join(root, "public", "real.txt"), join(root, "public", "alias.txt"));
  const result = await runArtifactCheck({ root, strict: false });
  assert.ok(!coverageReasons(result, "failed").includes("symlink-escape"));
  assert.equal(result.exitCode, 0);
});

test("artifacts mode never builds, starts a server or writes project files", async (t) => {
  const { root, marker } = await project(t, {
    files: {
      "public/app.js": "console.log('ok');\n",
      "app/page.tsx": "export default function Page() { return null; }\n",
    },
    nextConfig: "export default {};\n",
  });
  const before = {
    config: await readFile(join(root, "next.config.mjs"), "utf8"),
    build: await readFile(join(root, ".next", "BUILD_ID"), "utf8"),
    page: await readFile(join(root, "app", "page.tsx"), "utf8"),
  };
  const result = await runArtifactCheck({ root, strict: false });
  assert.equal(await readFile(marker, "utf8").catch(() => null), null);
  assert.equal(await readFile(join(root, "next.config.mjs"), "utf8"), before.config);
  assert.equal(await readFile(join(root, ".next", "BUILD_ID"), "utf8"), before.build);
  assert.equal(await readFile(join(root, "app", "page.tsx"), "utf8"), before.page);
  assert.equal(result.exitCode, 0);
});

test("fresh builds explicitly and then inspects the new output", async (t) => {
  const { root, marker } = await project(t);
  const result = await runArtifactCheck({ root, fresh: true, strict: false });
  assert.equal(await readFile(marker, "utf8"), "ran");
  assert.ok(result.coverage.checks.some((check) => check.rule === "build" && check.status === "checked"));
  assert.equal(result.buildFailed, false);
});

function runCli(cwd, args) {
  return spawnSync(process.execPath, [join(process.cwd(), "dist", "cli.js"), ...args], {
    cwd,
    encoding: "utf8",
    timeout: 30000,
  });
}

test("CLI --artifacts JSON and text expose stable rule IDs and mask values", async (t) => {
  const { root } = await project(t, {
    files: {
      "public/source.js.map": `{"version":3,"sources":["a"],"mappings":"AAAA","secret":"${SECRET}"}`,
      ".next/static/chunks/app.js": `const k = "${SECRET}";\n`,
    },
  });
  const json = runCli(root, ["--artifacts", "--json"]);
  assert.equal(json.status, 1, json.stderr);
  const payload = JSON.parse(json.stdout);
  assert.ok(payload.extra.some((item) => item.rule === "artifact-client-secret"));
  assert.ok(!json.stdout.includes(SECRET));

  const text = runCli(root, ["--artifacts"]);
  assert.equal(text.status, 1, text.stderr);
  assert.match(text.stdout, /artifact-client-secret/);
  assert.ok(!text.stdout.includes(SECRET));
});

test("CLI rejects ambiguous artifact mode combinations", async (t) => {
  const { root } = await project(t);
  for (const args of [
    ["--artifacts", "--fast"],
    ["--artifacts", "--update"],
    ["--artifacts", "--port", "3100"],
    ["--artifacts", "--reuse"],
    ["--artifacts", "--explain"],
    ["--artifacts", "--explain-with", "claude"],
    ["--fresh"],
  ]) {
    const result = runCli(root, args);
    assert.equal(result.status, 2, args.join(" "));
    assert.match(result.stderr, /kkomkkom:/);
  }
});

test("MCP artifacts mode works and rejects fresh without artifacts", async (t) => {
  const { root } = await project(t, {
    files: { ".next/static/chunks/app.js": `const k = "${SECRET}";\n` },
  });
  const child = spawn(process.execPath, ["dist/mcp.js"], { stdio: ["pipe", "pipe", "inherit"] });
  const lines = [];
  child.stdout.setEncoding("utf8");
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (;;) {
      const index = buffer.indexOf("\n");
      if (index < 0) break;
      lines.push(JSON.parse(buffer.slice(0, index)));
      buffer = buffer.slice(index + 1);
    }
  });
  const wait = (id) => new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const found = lines.findIndex((line) => line.id === id);
      if (found >= 0) {
        clearInterval(timer);
        resolve(lines.splice(found, 1)[0]);
      } else if (Date.now() - started > 10000) {
        clearInterval(timer);
        reject(new Error("MCP timeout"));
      }
    }, 10);
  });
  try {
    child.stdin.write(JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "kkomkkom", arguments: { projectPath: root, artifacts: true } },
    }) + "\n");
    const clean = await wait(1);
    assert.equal(clean.result.isError, true);
    assert.equal(clean.result.structuredContent.extra[0].rule, "artifact-client-secret");

    child.stdin.write(JSON.stringify({
      jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "kkomkkom", arguments: { projectPath: root, fresh: true } },
    }) + "\n");
    const bad = await wait(2);
    assert.equal(bad.result.isError, true);
    assert.match(bad.result.content[0].text, /fresh/);

    child.stdin.write(JSON.stringify({
      jsonrpc: "2.0", id: 3, method: "tools/call",
      params: { name: "kkomkkom", arguments: { projectPath: root, artifacts: true, fast: true } },
    }) + "\n");
    const conflict = await wait(3);
    assert.equal(conflict.result.isError, true);
  } finally {
    child.kill();
  }
});
