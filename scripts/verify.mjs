#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { constants, existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "dist", "cli.js");
const MCP = join(ROOT, "dist", "mcp.js");
const FIXTURE = join(ROOT, "fixtures", "mini-app");
const NPM = process.platform === "win32" ? "npm.cmd" : "npm";
const ARTIFACTS_ONLY = process.argv.includes("--artifacts-only");
const PROTECT_ONLY = process.argv.includes("--protect-only");

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

/** Compare source/config bytes in memory without creating secret-bearing digests. */
async function sourceSnapshot(root) {
  const files = [];
  const walk = async (dir) => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else {
        files.push([relative(root, path), (await readFile(path)).toString("base64")]);
      }
    }
  };
  for (const path of [join(root, "app"), join(root, "lib"), join(root, "public")]) {
    if (existsSync(path)) await walk(path);
  }
  for (const file of (await readdir(root)).sort()) {
    if (/^(?:next\.config\.|\.env)/.test(file) || ["kkomkkom.config.json", "package.json"].includes(file)) {
      files.push([file, (await readFile(join(root, file))).toString("base64")]);
    }
  }
  return JSON.stringify(files);
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

async function artifactServer(work) {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [join(work, "node_modules/next/dist/bin/next"), "start", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: work, detached: process.platform !== "win32", stdio: "ignore",
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
  });
  let spawnError = false;
  child.on("error", () => { spawnError = true; });
  const stop = async () => {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
    const closed = new Promise((resolveClose) => child.once("close", resolveClose));
    if (process.platform === "win32") run("taskkill", ["/pid", String(child.pid), "/T", "/F"]);
    else { try { process.kill(-child.pid, "SIGTERM"); } catch {} }
    let timer;
    await Promise.race([closed, new Promise((resolveStop) => {
      timer = setTimeout(() => {
        if (process.platform !== "win32") { try { process.kill(-child.pid, "SIGKILL"); } catch {} }
        resolveStop();
      }, 3000);
    })]);
    clearTimeout(timer);
  };
  try {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      if (spawnError || child.exitCode !== null || child.signalCode !== null) break;
      try {
        const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(1000) });
        await response.body?.cancel();
        if (response.ok) return { url, stop };
      } catch {}
      await new Promise((wait) => setTimeout(wait, 100));
    }
    throw new Error("temporary production server did not become ready (output withheld)");
  } catch (error) { await stop(); throw error; }
}

async function prepareArtifactFlow(work) {
  await writeFile(join(work, "next.config.mjs"), "export default { productionBrowserSourceMaps: true };\n");
  const fresh = run(process.execPath, [CLI, "--artifacts", "--fresh", "--json"], {
    cwd: work, env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
  });
  let freshReport;
  try { freshReport = JSON.parse(fresh.stdout); } catch {}
  check("artifacts: real production build produces browser maps", fresh.status === 0 &&
    freshReport?.extra.some((finding) => finding.rule === "artifact-source-map" && finding.file?.startsWith(".next/static/")));
  if (fresh.status !== 0) throw new Error("artifact fixture build failed (output withheld)");

  const known = ["private", "production", "credential", "0123456789"].join("-");
  const masked = ["real", "test", "service", "credential", "9876543210"].join("-");
  const provider = "sk_live_" + "ABCDEFGHIJKLMNOPQRST";
  await mkdir(join(work, "public"), { recursive: true });
  await writeFile(join(work, ".env.artifact"), `PRIVATE_TOKEN=${known}\nPRIVATE_TEST_TOKEN=${masked}\n`);
  await writeFile(join(work, "public/provider.js"), `const provider = ${JSON.stringify(provider)};\n`);
  await writeFile(join(work, "public/known.js"), `const known = ${JSON.stringify(known)};\n`);
  await writeFile(join(work, "public/reference.js"), `//# sourceMappingURL=${known}.map\n`);
  await writeFile(join(work, "public/suppressed.js.map"), '{"version":3,"sources":["a"],"mappings":"AAAA"}');
  const configPath = join(work, "kkomkkom.config.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.artifactExceptions = [{ ruleId: "artifact-source-map", file: "public/suppressed.js.map", reason: `review: ${masked}` }];
  await writeFile(configPath, JSON.stringify(config));
  const baseline = join(work, ".kkomkkom/baseline.json");
  await mkdir(dirname(baseline), { recursive: true });
  if (!existsSync(baseline)) await writeFile(baseline, '{"routes":{},"pages":{}}');
  const baselineRaw = await readFile(baseline, "utf8");
  const sources = await sourceSnapshot(work);
  const server = await artifactServer(work);
  return { work, baseline, baselineRaw, sources, secrets: [known, masked, provider], ...server };
}

async function verifyArtifactClient(flow, cliPath, mcpPath, label) {
  const safe = (text) => flow.secrets.every((value) => !text.includes(value));
  const staticRun = run(process.execPath, [cliPath, "--artifacts", "--json"], { cwd: flow.work });
  const served = run(process.execPath, [cliPath, "--artifacts", "--production-url", flow.url, "--json"], { cwd: flow.work });
  const text = run(process.execPath, [cliPath, "--artifacts", "--production-url", flow.url, "--lang", "ko"], { cwd: flow.work });
  let staticReport, report;
  try { staticReport = JSON.parse(staticRun.stdout); report = JSON.parse(served.stdout); } catch {}
  check(`${label}: static and explicit production HTTP share masked findings`, staticRun.status === 1 && served.status === 1 &&
    staticReport?.extra.some((finding) => finding.rule === "artifact-client-secret") &&
    report?.extra.some((finding) => finding.evidenceKind === "local-production-http" && finding.file.startsWith(".next/static/") && finding.file.endsWith(".map")) &&
    report.extra.some((finding) => finding.file === "public/known.js" && finding.severity === "warning"));
  check(`${label}: stdout/stderr JSON and translated report contain no credential values`,
    [staticRun, served, text].every((result) => safe(`${result.stdout}${result.stderr}`)) && text.status === 1);
  const input = run(process.execPath, [cliPath, "--artifacts", "--production-url", "http://user:private@127.0.0.1"], { cwd: flow.work });
  check(`${label}: CLI rejects unsafe origin without echo`, input.status === 2 && !input.stderr.includes("user:private"));

  const bad = await mkdtemp(join(tmpdir(), "kk-artifact-config-"));
  const configPath = join(flow.work, "kkomkkom.config.json");
  const originalConfig = await readFile(configPath, "utf8");
  try {
    const config = JSON.parse(originalConfig);
    config.artifactExceptions.push({ ruleId: "artifact-client-secret", file: "public/provider.js", reason: "intentional fake provider fixture" });
    await writeFile(configPath, JSON.stringify(config));
    const clean = run(process.execPath, [cliPath, "--artifacts", "--production-url", flow.url, "--json"], { cwd: flow.work });
    check(`${label}: reviewed fake-provider exception permits a normal CLI result`, clean.status === 0 && safe(`${clean.stdout}${clean.stderr}`));
    await writeFile(join(bad, "package.json"), '{"dependencies":{"next":"16.0.0"}}');
    await writeFile(join(bad, "kkomkkom.config.json"), JSON.stringify({ artifactExceptions: [{ ruleId: "unknown", file: "public/a", reason: flow.secrets[0] }] }));
    const cliError = run(process.execPath, [cliPath, "--artifacts", "--json"], { cwd: bad });
    const session = mcpSession(mcpPath, [
      toolCall(1, { projectPath: flow.work, artifacts: true, productionUrl: flow.url, lang: "en" }),
      toolCall(2, { projectPath: flow.work, artifacts: true, productionUrl: false }),
      toolCall(3, { projectPath: bad, artifacts: true }),
      { jsonrpc: "2.0", id: 4, method: "ping" },
    ]);
    const normal = session.responses.get(1)?.result;
    check(`${label}: MCP normal/input/config-error tools/call and stream survival`, session.status === 0 && normal?.isError === false &&
      normal?.structuredContent?.extra.some((finding) => finding.evidenceKind === "local-production-http") &&
      session.responses.get(2)?.result?.isError === true &&
      session.responses.get(3)?.result?.isError === true && session.responses.get(4)?.result !== undefined);
    check(`${label}: errors and MCP output contain no credential values`, cliError.status === 2 &&
      safe(`${cliError.stdout}${cliError.stderr}${session.stdout}${session.stderr}`));
    const { buildPrompt } = await import(new URL("explain.js", pathToFileURL(mcpPath)));
    const prompt = buildPrompt(normal.structuredContent.diff, "en", normal.structuredContent.extra);
    check(`${label}: explanation input contains no credential values (no AI invoked)`, safe(prompt));
  } finally {
    await writeFile(configPath, originalConfig);
    await rm(bad, { recursive: true, force: true });
  }
  check(`${label}: source/config/env/public and baseline bytes remain unchanged`,
    await sourceSnapshot(flow.work) === flow.sources && await readFile(flow.baseline, "utf8") === flow.baselineRaw);
}

async function prepareProtectionFlow(work) {
  const original = Buffer.from("// PRIVATE_PREVIEW_SENTINEL must never be printed\nexport default { productionBrowserSourceMaps: true };\n");
  await writeFile(join(work, "next.config.mjs"), original);
  await writeFile(join(work, ".env.protection"), "PRIVATE_TOKEN=private-protection-fixture-value-123456789\n");
  for (const args of [
    ["init", "-q"], ["add", "--", "next.config.mjs"],
    ["-c", "user.name=Protection Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "protection fixture"],
  ]) {
    const git = run("git", ["-C", work, ...args]);
    if (git.status !== 0) throw new Error("temporary protection Git fixture setup failed");
  }
  const initial = run(process.execPath, [CLI, "--artifacts", "--fresh", "--json"], { cwd: work });
  let report;
  try { report = JSON.parse(initial.stdout); } catch {}
  check("protection: initial real production output contains browser maps", initial.status === 0 &&
    report?.extra.some((finding) => finding.rule === "artifact-source-map" && finding.file?.startsWith(".next/static/")));
  if (initial.status !== 0) throw new Error("temporary protection build failed (output withheld)");
  const baseline = join(work, ".kkomkkom", "baseline.json");
  await mkdir(dirname(baseline), { recursive: true });
  if (!existsSync(baseline)) await writeFile(baseline, '{"version":1,"createdAt":"2026-10-23T00:00:00.000Z","routes":{},"pages":{}}');
  return { work, original, baseline, baselineRaw: await readFile(baseline), sources: await sourceSnapshot(work),
    configRaw: await readFile(join(work, "kkomkkom.config.json")) };
}

async function verifyProtectionClient(flow, cliPath, mcpPath, label) {
  const preview = run(process.execPath, [cliPath, "--protect-sourcemaps", "--json", "--lang", "en"], { cwd: flow.work });
  let plan;
  try { plan = JSON.parse(preview.stdout); } catch {}
  check(`${label}: preview is token-only and read-only`, preview.status === 0 && plan?.status === "change" &&
    plan.diff?.before === "true" && plan.diff?.after === "false" && /^[a-f0-9]{64}$/.test(plan.expectedHash) &&
    !/PRIVATE_PREVIEW_SENTINEL|private-protection-fixture-value/.test(preview.stdout + preview.stderr) &&
    await sourceSnapshot(flow.work) === flow.sources);
  if (!plan?.expectedHash) throw new Error("protection preview did not provide an approval token");
  const rejected = run(process.execPath, [cliPath, "--protect-sourcemaps", "--apply", "--expected-hash", "0".repeat(64)], { cwd: flow.work });
  check(`${label}: stale approval is refused without changes`, rejected.status === 2 && await sourceSnapshot(flow.work) === flow.sources);

  const applied = run(process.execPath, [cliPath, "--protect-sourcemaps", "--apply", "--expected-hash", plan.expectedHash, "--json", "--lang", "en"], { cwd: flow.work });
  let result;
  try { result = JSON.parse(applied.stdout); } catch {}
  check(`${label}: apply builds and verifies owned production, maps and cleanup`, applied.status === 0 &&
    result?.status === "applied" && result.rollback === "not-needed" && result.configChanged === true &&
    ["build", "artifacts", "smoke", "cleanup"].every((key) => result.verification?.[key] === "passed"), applied.stderr || applied.stdout);
  if (applied.status !== 0 || !result?.transactionId) throw new Error("real protection apply did not pass");
  const target = join(flow.work, "next.config.mjs");
  const changed = await readFile(target);
  check(`${label}: exact token change with durable original backup`, changed.equals(Buffer.from(flow.original.toString().replace(": true", ": false"))) &&
    (await readFile(join(flow.work, ".kkomkkom", "protection", result.transactionId, "original"))).equals(flow.original));
  const after = run(process.execPath, [cliPath, "--artifacts", "--json"], { cwd: flow.work });
  let afterReport;
  try { afterReport = JSON.parse(after.stdout); } catch {}
  check(`${label}: emitted browser maps are absent after rebuild`, after.status === 0 && afterReport?.coverage.status === "complete" &&
    !afterReport.extra.some((finding) => finding.rule === "artifact-source-map"));
  const tools = mcpSession(mcpPath, [{ jsonrpc: "2.0", id: 1, method: "tools/list" },
    toolCall(2, { projectPath: flow.work, protectSourcemaps: true }), { jsonrpc: "2.0", id: 3, method: "ping" }]);
  const listed = tools.responses.get(1)?.result?.tools ?? [];
  check(`${label}: MCP exposes no protection mutation tool`, tools.status === 0 && listed.length === 1 &&
    listed[0].name === "kkomkkom" && !/protect|restore|expectedHash/.test(JSON.stringify(listed[0].inputSchema)) &&
    tools.responses.get(2)?.result?.isError === true && tools.responses.get(3)?.result !== undefined &&
    (await readFile(target)).equals(changed));

  await writeFile(target, Buffer.concat([changed, Buffer.from("// later user edit\n")]));
  const refused = run(process.execPath, [cliPath, "--restore", result.transactionId, "--json"], { cwd: flow.work });
  check(`${label}: restore refuses later user edits`, refused.status === 2 &&
    (await readFile(target)).equals(Buffer.concat([changed, Buffer.from("// later user edit\n")])));
  await writeFile(target, changed);
  const restored = run(process.execPath, [cliPath, "--restore", result.transactionId, "--json"], { cwd: flow.work });
  let restoreReport;
  try { restoreReport = JSON.parse(restored.stdout); } catch {}
  check(`${label}: restore is byte-exact and preserves unrelated source/env/baseline`, restored.status === 0 && restoreReport?.restored === true &&
    (await readFile(target)).equals(flow.original) && await sourceSnapshot(flow.work) === flow.sources &&
    (await readFile(flow.baseline)).equals(flow.baselineRaw));
  check(`${label}: result does not claim generated build output was restored`, result.buildOutput === "may-have-changed" &&
    /config|設定|설정/.test(result.notes.join(" ")) && !/PRIVATE_PREVIEW_SENTINEL|private-protection-fixture-value/.test(applied.stdout + restored.stdout));
}

async function main() {
  const build = run(NPM, ["run", "build"], { cwd: ROOT });
  check("build", build.status === 0, build.stderr || build.stdout);

  if (!ARTIFACTS_ONLY && !PROTECT_ONLY) {
  const testDir = join(ROOT, "test");
  const testFiles = (await readdir(testDir))
    .filter((name) => name.endsWith(".test.js"))
    .map((name) => join(testDir, name));
  const tests = run(process.execPath, ["--test", ...testFiles], { cwd: ROOT });
  const passed = (tests.stdout.match(/^ℹ pass (\d+)$/m) ?? [])[1] ?? "?";
  check(`unit tests (${passed})`, tests.status === 0, tests.stdout || tests.stderr);
  }

  if (!existsSync(join(FIXTURE, "node_modules"))) {
    throw new Error("cached fixture dependencies are required; verification does not install into the repository fixture");
  }

  const work = await mkdtemp(join(tmpdir(), "kkomkkom-verify-"));
  let artifactFlow;
  let protectionFlow;
  try {
    for (const entry of ["app", "lib", "package.json", "tsconfig.json", "next-env.d.ts"]) {
      if (existsSync(join(FIXTURE, entry))) {
        await cp(join(FIXTURE, entry), join(work, entry), { recursive: true });
      }
    }
    await cp(join(FIXTURE, "node_modules"), join(work, "node_modules"), { recursive: true, mode: constants.COPYFILE_FICLONE });
    // Auth calls in source are evidence, not a policy: an explicit protected
    // policy is what turns a 2xx into an exposed finding.
    await writeFile(
      join(work, "kkomkkom.config.json"),
      JSON.stringify({
        routePolicies: { "/api/leak": { GET: "protected" } },
        sampleParams: { "/api/orders/[id]": { id: "1" } },
      }),
    );

    if (!ARTIFACTS_ONLY && !PROTECT_ONLY) {
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
    const beforeSources = await sourceSnapshot(work);
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
       await sourceSnapshot(work) === beforeSources &&
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
    check("production build: source bytes are still unchanged", await sourceSnapshot(work) === beforeSources);

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

    }
    if (!ARTIFACTS_ONLY) {
      protectionFlow = await prepareProtectionFlow(work);
      await verifyProtectionClient(protectionFlow, CLI, MCP, "protection repo");
    }
    if (!PROTECT_ONLY) {
      artifactFlow = await prepareArtifactFlow(work);
      await verifyArtifactClient(artifactFlow, CLI, MCP, "artifacts repo");
    }

    // A packed consumer installs with production dependencies only.
    const packDir = await mkdtemp(join(tmpdir(), "kkomkkom-verify-pack-"));
    const consumer = await mkdtemp(join(tmpdir(), "kkomkkom-verify-consumer-"));
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
          ["install", "--omit=dev", "--no-audit", "--no-fund", "--offline", tarball],
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
        check("pack: consumer CLI runs", version.status === 0 && version.stdout.trim() === packed?.version, version.stderr);

        if (!ARTIFACTS_ONLY && !PROTECT_ONLY) {
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
        }
        if (artifactFlow) await verifyArtifactClient(artifactFlow, consumerCli, consumerMcp, "artifacts packed consumer");
        if (protectionFlow) {
          if (artifactFlow) {
            await artifactFlow.stop();
            artifactFlow = undefined;
            // Only files created by prepareArtifactFlow in this owned temporary fixture.
            for (const file of [".env.artifact", "public/provider.js", "public/known.js", "public/reference.js", "public/suppressed.js.map"]) {
              await rm(join(work, file));
            }
            await writeFile(join(work, "next.config.mjs"), protectionFlow.original);
            await writeFile(join(work, "kkomkkom.config.json"), protectionFlow.configRaw);
          }
          await verifyProtectionClient(protectionFlow, consumerCli, consumerMcp, "protection packed consumer");
        }

        const size = (await stat(tarball)).size;
        console.log(`  · packed ${size} bytes; consumer install ${installMs} ms`);
      }
    } finally {
      await rm(packDir, { recursive: true, force: true });
      await rm(consumer, { recursive: true, force: true });
    }
  } finally {
    await artifactFlow?.stop();
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
