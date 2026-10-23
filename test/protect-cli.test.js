import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, readdir, rm, cp, symlink } from "node:fs/promises";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createHash } from "node:crypto";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const mcp = fileURLToPath(new URL("../dist/mcp.js", import.meta.url));
const original = "module.exports = { productionBrowserSourceMaps: true, env: { PASSWORD: 'PRIVATE_SENTINEL' } };\n";
async function fixture(t) {
  const root = await mkdtemp("/tmp/opencode/kk-protect-cli-");
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { next: "16.0.0" } }));
  await writeFile(join(root, "next.config.js"), original);
  execFileSync("git", ["init", "-q", root]);
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  git("add", "package.json", "next.config.js");
  git("commit", "-qm", "fixture");
  return root;
}
const invoke = (cwd, ...args) => spawnSync(process.execPath, [cli, ...args], { cwd, encoding: "utf8", timeout: 20000, env: { ...process.env, CI: "1", NO_COLOR: "1" } });

test("protection module loads only after valid explicit CLI selection, never for inspection or MCP", async (t) => {
  const root = await fixture(t);
  const copy = join(root, "tool");
  await cp(new URL("../dist/", import.meta.url), join(copy, "dist"), { recursive: true });
  await writeFile(join(copy, "package.json"), JSON.stringify({ type: "module", version: "0.1.0" }));
  await symlink(fileURLToPath(new URL("../node_modules/", import.meta.url)), join(copy, "node_modules"));
  await writeFile(join(copy, "dist", "protect.js"), 'export const applyAndVerifyProtection = null, previewProtection = null, restoreProtection = null;\nexport class ProtectionError extends Error {}\nthrow new Error("PROTECTION_MODULE_INITIALIZED");\n');
  await writeFile(join(root, "next.config.js"), "module.exports = { productionBrowserSourceMaps: false };\n");
  const invokeCopy = (...args) => spawnSync(process.execPath, [join(copy, "dist", "cli.js"), ...args], {
    cwd: root, encoding: "utf8", timeout: 20000, env: { ...process.env, NO_COLOR: "1" },
  });
  const help = invokeCopy("--help");
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /Usage/);
  const standard = invokeCopy("--lang", "en");
  assert.equal(standard.status, 2);
  assert.match(standard.stderr, /no.*routes/i);
  const artifacts = invokeCopy("--artifacts", "--json", "--lang", "en");
  assert.equal(artifacts.status, 0, artifacts.stderr);
  assert.equal(JSON.parse(artifacts.stdout).schemaVersion, 2);
  for (const args of [["--apply"], ["--protect-sourcemaps", "--artifacts"]]) {
    const invalid = invokeCopy(...args, "--lang", "en");
    assert.equal(invalid.status, 2);
    assert.match(invalid.stderr, /Invalid protection mode/);
    assert.doesNotMatch(invalid.stderr, /PROTECTION_MODULE_INITIALIZED/);
  }
  const input = [
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "kkomkkom", arguments: { projectPath: root, artifacts: true, lang: "en" } } },
    { jsonrpc: "2.0", id: 2, method: "ping" },
  ].map((call) => JSON.stringify(call)).join("\n") + "\n";
  const inspection = spawnSync(process.execPath, [join(copy, "dist", "mcp.js")], { cwd: root, encoding: "utf8", input, timeout: 20000 });
  assert.equal(inspection.status, 0, inspection.stderr);
  const replies = inspection.stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(replies.find((reply) => reply.id === 1).result.structuredContent.schemaVersion, 2);
  assert.ok(replies.find((reply) => reply.id === 2).result);
  assert.doesNotMatch([help.stderr, standard.stderr, artifacts.stderr, inspection.stderr].join("\n"), /PROTECTION_MODULE_INITIALIZED/);
  const selected = invokeCopy("--protect-sourcemaps", "--json", "--lang", "en");
  assert.equal(selected.status, 2);
  assert.match(selected.stderr, /PROTECTION_MODULE_INITIALIZED/);
});

test("MCP rejects protection arguments before inspection and keeps its stream alive", async (t) => {
  const root = await fixture(t);
  const keys = ["protectSourcemaps", "protect-sourcemaps", "apply", "expectedHash", "expected-hash", "restore"];
  const calls = keys.map((key, id) => ({ jsonrpc: "2.0", id, method: "tools/call", params: {
    name: "kkomkkom", arguments: { projectPath: root, artifacts: true, lang: "en", [key]: true },
  } }));
  calls.push({ jsonrpc: "2.0", id: 99, method: "ping" });
  const result = spawnSync(process.execPath, [mcp], { cwd: root, input: calls.map((call) => JSON.stringify(call)).join("\n") + "\n", encoding: "utf8", timeout: 20000 });
  assert.equal(result.status, 0, result.stderr);
  const responses = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
  for (const id of keys.keys()) {
    const response = responses.find((message) => message.id === id);
    assert.equal(response.result.isError, true, keys[id]);
    assert.match(response.result.content[0].text, /protection/);
  }
  assert.ok(responses.find((message) => message.id === 99).result);
  assert.deepEqual(await readFile(join(root, "next.config.js")), Buffer.from(original));
  assert.equal((await readdir(root)).includes(".kkomkkom"), false);
});

test("protection CLI unsupported preview agrees with its JSON exit code; false is a no-op", async (t) => {
  const root = await fixture(t);
  for (const [source, status, code] of [
    ["export default wrapped({ productionBrowserSourceMaps: true })", "unsupported", 2],
    ["export default { productionBrowserSourceMaps: false }", "noop", 0],
  ]) {
    await writeFile(join(root, "next.config.js"), source);
    const result = invoke(root, "--protect-sourcemaps", "--json");
    assert.equal(result.status, code);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, status);
    assert.equal(payload.exitCode, code);
    assert.equal(payload.applyCommand, undefined);
    assert.equal(await readFile(join(root, "next.config.js"), "utf8"), source);
  }
});

test("protection CLI defaults to safe preview with explicit token approval and localized impact notes", async (t) => {
  const root = await fixture(t);
  const hash = createHash("sha256").update(original).digest("hex");
  for (const lang of ["en", "ko", "ja", "zh", "es"]) {
    const result = invoke(root, "--protect-sourcemaps", "--json", "--lang", lang);
    assert.equal(result.status, 0, result.stderr);
    const preview = JSON.parse(result.stdout);
    assert.equal(preview.status, "change");
    assert.equal(preview.expectedHash, hash);
    assert.equal(preview.notes.length, 3);
    assert.ok(preview.notes.every((note) => typeof note === "string" && note.length > 10));
    assert.match(preview.applyCommand, new RegExp(`--apply --expected-hash ${hash}`));
    assert.match(preview.restoreCommand, /--restore/);
    assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE_SENTINEL|PASSWORD/);
  }
  const text = invoke(root, "--protect-sourcemaps", "--lang", "en");
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /next\.config\.js:1:\d+/);
  assert.match(text.stdout, /- true\n\+ false/);
  assert.match(text.stdout, /no.*dependenc|dependenc.*not/i);
  assert.deepEqual(await readFile(join(root, "next.config.js")), Buffer.from(original));
  assert.equal((await readdir(root)).includes(".kkomkkom"), false);
});

test("protection CLI rejects conflicting and incomplete runtime modes before any mutation", async (t) => {
  const root = await fixture(t);
  const hash = "a".repeat(64);
  const conflicts = [
    ["--apply"], ["--expected-hash", hash], ["--protect-sourcemaps", "--apply"],
    ["--protect-sourcemaps", "--expected-hash", hash],
    ["--protect-sourcemaps", "--apply", "--expected-hash", "invalid"],
    ["--protect-sourcemaps", "--restore", "bad"],
    ["--restore", "../escape"], ["--restore", ""],
    ["--restore", "00000000-0000-4000-8000-000000000000", "--apply"],
    ["--restore", "00000000-0000-4000-8000-000000000000", "--expected-hash", hash],
    ...["--artifacts", "--fast", "--fresh", "--update", "--strict", "--reuse", "--explain"].map((flag) => ["--protect-sourcemaps", flag]),
    ["--protect-sourcemaps", "--production-url", "http://127.0.0.1:3100"],
    ["--protect-sourcemaps", "--explain-with", "claude"], ["--protect-sourcemaps", "--port", "3100"],
  ];
  for (const args of conflicts) {
    const result = invoke(root, ...args, "--lang", "en");
    assert.equal(result.status, 2, args.join(" "));
    assert.match(result.stderr, /protection/i);
    assert.doesNotMatch(result.stderr, /Unknown option|PRIVATE_SENTINEL/);
  }
  assert.deepEqual(await readFile(join(root, "next.config.js")), Buffer.from(original));
  assert.equal((await readdir(root)).includes(".kkomkkom"), false);
});

test("protection CLI build failure reports rollback separately and restores original bytes", async (t) => {
  const root = await fixture(t);
  const hash = createHash("sha256").update(original).digest("hex");
  const result = invoke(root, "--protect-sourcemaps", "--apply", "--expected-hash", hash, "--json", "--lang", "en");
  assert.equal(result.status, 1, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.verification.build, "failed");
  assert.equal(payload.rollback, "restored");
  assert.match(payload.restoreCommand, /--restore [a-f0-9-]{36}/);
  assert.equal(payload.buildOutput, "may-have-changed");
  assert.deepEqual(await readFile(join(root, "next.config.js")), Buffer.from(original));
  assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE_SENTINEL|PASSWORD/);
});
