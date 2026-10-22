import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createHash } from "node:crypto";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
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
