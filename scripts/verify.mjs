#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "dist", "cli.js");
const MCP = join(ROOT, "dist", "mcp.js");
const FIXTURE = join(ROOT, "fixtures", "mini-app");
const NPM = process.platform === "win32" ? "npm.cmd" : "npm";

let failed = 0;

function check(name, ok, detail = "") {
  console.log(`${ok ? "✔" : "✘"} ${name}`);
  if (ok) return;
  failed += 1;
  if (detail) {
    const tail = detail.trim().split("\n").slice(-15).join("\n");
    console.log(tail.replace(/^/gm, "    "));
  }
}

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: "utf8",
    timeout: 240_000,
    ...options,
  });
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

async function runCli(args, cwd) {
  const port = await freePort();
  return run(process.execPath, [CLI, "--fast", ...args, "--port", String(port)], { cwd });
}

/** Hash app/lib source and config so a default check cannot silently edit them. */
async function sourceDigest(root) {
  const hash = createHash("sha256");
  const walk = async (dir) => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else {
        hash.update(relative(root, path));
        hash.update(await readFile(path));
      }
    }
  };
  for (const path of [join(root, "app"), join(root, "lib")]) {
    if (existsSync(path)) await walk(path);
  }
  const config = join(root, "kkomkkom.config.json");
  if (existsSync(config)) hash.update(await readFile(config));
  return hash.digest("hex");
}

/** Run MCP requests in one short session and collect responses by id. */
function mcpSession(mcpPath, calls) {
  const input = calls.map((call) => JSON.stringify(call)).join("\n") + "\n";
  const result = run(process.execPath, [mcpPath], { input, timeout: 240_000 });
  const responses = new Map();
  for (const line of (result.stdout ?? "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const message = JSON.parse(line);
      responses.set(message.id, message);
    } catch {
      // A non-JSON line is reported by the asserting checks below.
    }
  }
  return { ...result, responses };
}

function toolCall(id, args) {
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name: "kkomkkom", arguments: args } };
}

async function main() {
  const build = run(NPM, ["run", "build"], { cwd: ROOT });
  check("build", build.status === 0, build.stderr || build.stdout);

  const testDir = join(ROOT, "test");
  const testFiles = (await readdir(testDir))
    .filter((name) => name.endsWith(".test.js"))
    .map((name) => join(testDir, name));
  const tests = run(process.execPath, ["--test", ...testFiles], { cwd: ROOT });
  const passed = (tests.stdout.match(/^ℹ pass (\d+)$/m) ?? [])[1] ?? "?";
  check(`unit tests (${passed})`, tests.status === 0, tests.stdout || tests.stderr);

  if (!existsSync(join(FIXTURE, "node_modules"))) {
    const install = run(NPM, ["ci"], { cwd: FIXTURE });
    check("install fixture dependencies", install.status === 0, install.stderr || install.stdout);
    if (install.status !== 0) {
      console.log(`\n${failed} check(s) failed.`);
      process.exit(1);
    }
  }

  const work = await mkdtemp(join(ROOT, ".verify-"));
  try {
    for (const entry of ["app", "lib", "package.json", "tsconfig.json", "next-env.d.ts"]) {
      if (existsSync(join(FIXTURE, entry))) {
        await cp(join(FIXTURE, entry), join(work, entry), { recursive: true });
      }
    }
    await symlink(
      join(FIXTURE, "node_modules"),
      join(work, "node_modules"),
      process.platform === "win32" ? "junction" : "dir",
    );
    // Auth calls in source are evidence, not a policy: an explicit protected
    // policy is what turns a 2xx into an exposed finding.
    await writeFile(
      join(work, "kkomkkom.config.json"),
      JSON.stringify({
        routePolicies: { "/api/leak": { GET: "protected" } },
        sampleParams: { "/api/orders/[id]": { id: "1" } },
      }),
    );

    const ko = await runCli(["--json", "--lang", "ko"], work);
    let report = null;
    try {
      report = JSON.parse(ko.stdout);
    } catch {
      // reported below
    }
    const leak = report?.diff?.routes?.find((route) => route.path === "/api/leak");
    check("real app: an open API exits 1", ko.status === 1, ko.stderr || ko.stdout);
    check("real app: the open API is critical", leak?.severity === "critical", ko.stdout);
    check("real app: JSON includes an extra array", Array.isArray(report?.extra), ko.stdout);
    check(
      "real app: detail follows --lang ko",
      /보호 대상으로 지정했는데/.test(leak?.detail ?? ""),
      ko.stdout,
    );

    const ja = await runCli(["--lang", "ja"], work);
    check(
      "real app: report follows --lang ja",
      ja.status === 1 && ja.stdout.includes("デプロイを止めてください"),
      ja.stderr || ja.stdout,
    );

    const update = await runCli(["--json", "--update"], work);
    check(
      "first --fast --update writes a baseline",
      update.status === 1 && existsSync(join(work, ".kkomkkom", "baseline.json")),
      update.stderr || update.stdout,
    );

    await writeFile(
      join(work, "kkomkkom.config.json"),
      JSON.stringify({ ignoreRoutes: ["/api/leak", "/api/orders/*"] }),
    );

    const warn = await runCli(["--lang", "es"], work);
    check(
      "warnings alone exit 0",
      warn.status === 0 && warn.stdout.includes("Revisa antes de desplegar"),
      warn.stderr || warn.stdout,
    );

    const strict = await runCli(["--lang", "es", "--strict"], work);
    check(
      "--strict turns warnings into exit 1",
      strict.status === 1 && strict.stdout.includes("Revisa antes de desplegar"),
      strict.stderr || strict.stdout,
    );

    await mkdir(join(work, "app", "broken"), { recursive: true });
    await writeFile(
      join(work, "app", "broken", "page.tsx"),
      'export default function Broken() { throw new Error("boom"); }\n',
    );
    await mkdir(join(work, "app", "api", "write"), { recursive: true });
    await writeFile(
      join(work, "app", "api", "write", "route.ts"),
      "export async function POST() { return Response.json({ ok: true }); }\n",
    );
    await writeFile(join(work, "lib", "leaked.ts"), 'export const key = "sk_live_FAKE0123456789ABCDEF";\n');
    await writeFile(join(work, ".env.local"), "NEXT_PUBLIC_API_SECRET=real-value\n");

    const extras = await runCli(["--json", "--lang", "ko"], work);
    let extrasReport = null;
    try {
      extrasReport = JSON.parse(extras.stdout);
    } catch {
      // reported below
    }
    const extraIds = new Set((extrasReport?.extra ?? []).map((item) => item.id));
    check("real app: a hardcoded secret stops the deploy", extras.status === 1 && extraIds.has("hardcoded-secret:lib/leaked.ts:1"), extras.stderr || extras.stdout);
    check("real app: a public secret warns", extraIds.has("public-secret:NEXT_PUBLIC_API_SECRET"), extras.stdout);
    check("real app: a write API without auth warns", extraIds.has("write-no-auth:/api/write:POST"), extras.stdout);
    check("real app: a broken page warns", extraIds.has("page-error:/broken"), extras.stdout);
    const hardcoded = (extrasReport?.extra ?? []).find((item) => item.id.startsWith("hardcoded-secret:"));
    check("real app: extra detail follows --lang ko", /비밀키로 보이는 값/.test(hardcoded?.message ?? ""), extras.stdout);

    await rm(join(work, "lib", "leaked.ts"), { force: true });
    await rm(join(work, ".env.local"), { force: true });
    await writeFile(
      join(work, "kkomkkom.config.json"),
      JSON.stringify({ ignoreRoutes: ["/api/leak", "/api/orders/*", "/api/health"] }),
    );
    const warnExtras = await runCli(["--json", "--lang", "en"], work);
    check("real app: warning-only project checks exit 0", warnExtras.status === 0, warnExtras.stderr || warnExtras.stdout);
    const strictExtras = await runCli(["--json", "--lang", "en", "--strict"], work);
    check("real app: --strict applies to project-check warnings", strictExtras.status === 1, strictExtras.stderr || strictExtras.stdout);

    // A real production build, not --fast: verify manifests, measured weights,
    // complete coverage, an explicit update and a byte-identical repeat.
    await rm(join(work, "app", "broken"), { recursive: true, force: true });
    await rm(join(work, "app", "api", "write"), { recursive: true, force: true });
    await writeFile(
      join(work, "kkomkkom.config.json"),
      JSON.stringify({
        ignoreRoutes: ["/api/health"],
        sampleParams: { "/api/orders/[id]": { id: "1" } },
        routePolicies: { "/api/leak": { GET: "public" } },
      }),
    );
    const baselineFile = join(work, ".kkomkkom", "baseline.json");
    const beforeSources = await sourceDigest(work);
    const baselineBeforeBuild = await readFile(baselineFile, "utf8");

    const prodPort = await freePort();
    const prod = run(process.execPath, [CLI, "--json", "--lang", "en", "--port", String(prodPort)], { cwd: work });
    let prodReport = null;
    try {
      prodReport = JSON.parse(prod.stdout);
    } catch {
      // reported below
    }
    const measured = new Map((prodReport?.diff?.pages ?? []).map((page) => [page.path, page]));
    check(
      "production build: complete non-fast run exits 0",
      prod.status === 0 && prodReport?.coverage?.status === "complete",
      prod.stderr || prod.stdout,
    );
    check(
      "production build: measured weights for every page",
      ["/", "/checkout"].every((path) => {
        const page = measured.get(path);
        return page?.to > 0 && page?.toMethod === "manifest-file";
      }),
      prod.stdout,
    );
    check(
      "production build: real build and client-reference manifests exist",
      existsSync(join(work, ".next", "BUILD_ID")) &&
        existsSync(join(work, ".next", "build-manifest.json")) &&
        existsSync(join(work, ".next", "server", "app", "page_client-reference-manifest.js")),
      "expected .next build artifacts",
    );
    check(
      "production build: a default check does not modify sources or the baseline",
      await sourceDigest(work) === beforeSources &&
        await readFile(baselineFile, "utf8") === baselineBeforeBuild,
    );

    const prodUpdate = run(process.execPath, [CLI, "--json", "--update", "--lang", "en", "--port", String(await freePort())], { cwd: work });
    let saved = null;
    try {
      saved = JSON.parse(await readFile(baselineFile, "utf8"));
    } catch {
      // reported below
    }
    check(
      "production build: explicit update stores measured page methods",
      prodUpdate.status === 0 &&
        saved?.pages?.["/"]?.method === "manifest-file" &&
        saved?.pages?.["/checkout"]?.method === "manifest-file" &&
        saved.pages["/"].firstLoadJs > 0,
      prodUpdate.stderr || prodUpdate.stdout,
    );
    const savedRaw = await readFile(baselineFile, "utf8");
    const prodRepeat = run(process.execPath, [CLI, "--json", "--lang", "en", "--port", String(await freePort())], { cwd: work });
    check(
      "production build: a later default check keeps the baseline byte-identical",
      prodRepeat.status === 0 && await readFile(baselineFile, "utf8") === savedRaw,
      prodRepeat.stderr || prodRepeat.stdout,
    );
    check("production build: source digest is still unchanged", await sourceDigest(work) === beforeSources);

    const badConfig = join(work, "bad-config-project");
    await mkdir(badConfig, { recursive: true });
    await writeFile(join(badConfig, "package.json"),
      JSON.stringify({ name: "bad-config", dependencies: { next: "16.0.0" } }));
    await writeFile(join(badConfig, "kkomkkom.config.json"), JSON.stringify({ port: 0 }));
    const configPath = join(work, "kkomkkom.config.json");
    const mcpConfig = JSON.parse(await readFile(configPath, "utf8"));
    mcpConfig.port = await freePort();
    await writeFile(configPath, JSON.stringify(mcpConfig));
    const notNext = await mkdtemp(join(tmpdir(), "kkomkkom-not-next-"));
    try {
      const mcp = mcpSession(MCP, [
        { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } },
        toolCall(2, { projectPath: work, fast: true, lang: "en" }),
        toolCall(3, { projectPath: 123 }),
        toolCall(4, { projectPath: notNext }),
        toolCall(5, { projectPath: badConfig }),
        { jsonrpc: "2.0", id: 6, method: "ping" },
      ]);
      const normal = mcp.responses.get(2);
      check(
        "MCP tools/call: normal fast run returns the shared result",
        mcp.status === 0 && normal?.result?.isError === false &&
          normal.result.structuredContent?.schemaVersion === 2 &&
          normal.result.structuredContent.coverage?.status === "complete",
        mcp.stderr || mcp.stdout,
      );
      const inputError = mcp.responses.get(3);
      check(
        "MCP tools/call: invalid input is a tool error",
        inputError?.result?.isError === true &&
          /projectPath/.test(inputError.result.content?.[0]?.text ?? ""),
        JSON.stringify(inputError),
      );
      const projectError = mcp.responses.get(4);
      check(
        "MCP tools/call: a non-Next project is a tool error",
        projectError?.result?.isError === true &&
          /No Next\.js project/.test(projectError.result.content?.[0]?.text ?? ""),
        JSON.stringify(projectError),
      );
      const configError = mcp.responses.get(5);
      check(
        "MCP tools/call: invalid config names the field",
        configError?.result?.isError === true &&
          /\bport\b/.test(configError.result.content?.[0]?.text ?? ""),
        JSON.stringify(configError),
      );
      check("MCP stream survives tool errors", mcp.responses.get(6)?.result !== undefined, mcp.stdout);
    } finally {
      await rm(notNext, { recursive: true, force: true });
      await rm(badConfig, { recursive: true, force: true });
    }

    // A packed consumer installs with production dependencies only.
    const packDir = await mkdtemp(join(ROOT, ".verify-pack-"));
    const consumer = await mkdtemp(join(ROOT, ".verify-consumer-"));
    await writeFile(
      join(consumer, "package.json"),
      JSON.stringify({ name: "kkomkkom-consumer", version: "1.0.0", private: true }),
    );
    try {
      const pack = run(NPM, ["pack", "--json", "--pack-destination", packDir], { cwd: ROOT });
      let packed = null;
      try {
        const parsed = JSON.parse(pack.stdout);
        packed = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
      } catch {
        // reported below
      }
      const filename = packed?.filename;
      const tarball = filename ? resolve(packDir, filename) : "";
      check("pack: npm pack succeeds", pack.status === 0 && existsSync(tarball), pack.stderr || pack.stdout);
      if (tarball) {
        const listing = run("tar", ["-tzf", tarball]);
        check(
          "pack: tarball carries dist, not src or tests",
          listing.status === 0 &&
            /package\/dist\/cli\.js/.test(listing.stdout) &&
            !/package\/(src|test)\//.test(listing.stdout),
          listing.stderr || listing.stdout,
        );

        const installStart = Date.now();
        const install = run(
          NPM,
          ["install", "--omit=dev", "--no-audit", "--no-fund", "--prefer-offline", tarball],
          { cwd: consumer, timeout: 240_000 },
        );
        const installMs = Date.now() - installStart;
        check("pack: production-only consumer install succeeds", install.status === 0, install.stderr || install.stdout);
        check(
          "pack: production install has typescript but no dev-only types",
          existsSync(join(consumer, "node_modules", "typescript", "package.json")) &&
            !existsSync(join(consumer, "node_modules", "@types", "node")),
          install.stdout,
        );

        const consumerCli = join(consumer, "node_modules", "kkomkkom", "dist", "cli.js");
        const consumerMcp = join(consumer, "node_modules", "kkomkkom", "dist", "mcp.js");
        const version = run(process.execPath, [consumerCli, "--version"], { cwd: consumer });
        check("pack: consumer CLI runs", version.status === 0 && version.stdout.trim() === "0.1.0", version.stderr);

        const consumerRun = run(
          process.execPath,
          [consumerCli, "--fast", "--json", "--lang", "en", "--port", String(await freePort())],
          { cwd: work },
        );
        let consumerReport = null;
        try {
          consumerReport = JSON.parse(consumerRun.stdout);
        } catch {
          // reported below
        }
        check(
          "pack: consumer CLI checks the app with production dependencies",
          consumerRun.status === 0 && consumerReport?.schemaVersion === 2 &&
            consumerReport.coverage?.status === "complete",
          consumerRun.stderr || consumerRun.stdout,
        );

        const consumerSession = mcpSession(consumerMcp, [
          { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
          toolCall(2, { projectPath: work, fast: true, lang: "en" }),
          { jsonrpc: "2.0", id: 3, method: "ping" },
        ]);
        const consumerNormal = consumerSession.responses.get(2);
        check(
          "pack: consumer MCP tools/call returns the shared result",
          consumerSession.status === 0 && consumerNormal?.result?.isError === false &&
            consumerNormal.result.structuredContent?.schemaVersion === 2 &&
            consumerSession.responses.get(3)?.result !== undefined,
          consumerSession.stderr || consumerSession.stdout,
        );

        const size = (await stat(tarball)).size;
        console.log(`  · packed ${size} bytes; consumer install ${installMs} ms`);
      }
    } finally {
      await rm(packDir, { recursive: true, force: true });
      await rm(consumer, { recursive: true, force: true });
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }

  const total = failed === 0 ? "all checks passed" : `${failed} check(s) failed`;
  console.log(`\n${total}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
