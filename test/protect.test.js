import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, chmod, stat, mkdir, symlink, readdir } from "node:fs/promises";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { watch, chmodSync } from "node:fs";

const engine = await import("../dist/protect.js").catch(() => ({}));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const original = Buffer.from("// private sentinel MUST_NOT_PRINT\r\nmodule.exports = { productionBrowserSourceMaps: true, env: { PRIVATE: 'DO_NOT_PRINT' } };\r\n");
const git = (root, ...args) => execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });
async function fixture(t, text = original, name = "next.config.js") {
  const root = await mkdtemp("/tmp/opencode/kk-protect-test-");
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, "init", "-q");
  git(root, "config", "user.email", "fixture@example.invalid");
  git(root, "config", "user.name", "Fixture");
  await writeFile(join(root, name), text);
  git(root, "add", name);
  git(root, "commit", "-qm", "fixture");
  return root;
}

test("protection preview replaces only the true token in direct exports, without config disclosure", async (t) => {
  assert.equal(typeof engine.previewProtection, "function");
  for (const [name, source] of [
    ["next.config.js", original],
    ["next.config.cjs", "module.exports = { 'productionBrowserSourceMaps': true }"],
    ["next.config.mjs", "export default { productionBrowserSourceMaps: true };"],
    ["next.config.ts", "export default { productionBrowserSourceMaps: true } satisfies NextConfig;"],
  ]) {
    const root = await fixture(t, source, name);
    const preview = await engine.previewProtection(root);
    assert.equal(preview.status, "change");
    assert.equal(preview.file, name);
    assert.equal(preview.expectedHash, hash(source));
    assert.equal(preview.diff.before, "true");
    assert.equal(preview.diff.after, "false");
    assert.ok(preview.diff.line >= 1 && preview.diff.column >= 1);
    assert.doesNotMatch(JSON.stringify(preview), /MUST_NOT_PRINT|DO_NOT_PRINT|PRIVATE/);
    assert.deepEqual(await readFile(join(root, name)), Buffer.from(source));
    assert.equal((await readdir(root)).includes(".kkomkkom"), false);
  }
});

test("protection rejects ambiguous configs without executing them; absent and false are no-op", async (t) => {
  assert.equal(typeof engine.previewProtection, "function");
  for (const source of ["export default {}", "module.exports = { productionBrowserSourceMaps: false }"]) {
    const root = await fixture(t, source);
    assert.equal((await engine.previewProtection(root)).status, "noop");
  }
  for (const source of [
    "export default wrapper({ productionBrowserSourceMaps: true })",
    "const cfg = { productionBrowserSourceMaps: true }; export default cfg",
    "module.exports = { productionBrowserSourceMaps: true, ...other }",
    "module.exports = { productionBrowserSourceMaps: true, ['other']: 1 }",
    "module.exports = { productionBrowserSourceMaps: true, productionBrowserSourceMaps: false }",
    "module.exports = { productionBrowserSourceMaps: true }; module.exports = {}",
    "module.exports = { productionBrowserSourceMaps: true }; module.exports.productionBrowserSourceMaps = true",
    "process.exit(99); module.exports = { productionBrowserSourceMaps: true }",
    "module.exports = { productionBrowserSourceMaps: getValue() }",
    "module.exports = { productionBrowserSourceMaps: true, env: { KEY: 'unterminated } }",
  ]) {
    const root = await fixture(t, source);
    assert.equal((await engine.previewProtection(root)).status, "unsupported", source);
  }
  const root = await fixture(t);
  await writeFile(join(root, "next.config.mjs"), "export default {}");
  assert.equal((await engine.previewProtection(root)).status, "unsupported");
});

test("protection apply has durable private exact backup, preserves mode, and hash-safe restore", async (t) => {
  assert.equal(typeof engine.applyProtection, "function");
  const root = await fixture(t);
  const target = join(root, "next.config.js");
  await chmod(target, 0o640);
  const result = await engine.applyProtection(root, hash(original));
  assert.match(result.transactionId, /^[a-f0-9-]{36}$/);
  assert.deepEqual(await readFile(target), Buffer.from(original.toString().replace(": true", ": false")));
  assert.equal((await stat(target)).mode & 0o777, 0o640);
  const dir = join(root, ".kkomkkom", "protection", result.transactionId);
  assert.deepEqual(await readFile(join(dir, "original")), original);
  assert.equal((await stat(join(dir, "original"))).mode & 0o777, 0o600);
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
  await engine.restoreProtection(root, result.transactionId);
  assert.deepEqual(await readFile(target), original);
  assert.equal((await stat(target)).mode & 0o777, 0o640);
  await assert.rejects(engine.restoreProtection(root, result.transactionId));
});

test("protection backup Git exclusion prevents ordinary staging without changing user ignore files", async (t) => {
  for (const existingIgnore of [false, true]) {
    const root = await fixture(t);
    const ignore = join(root, ".gitignore");
    const userIgnore = "# user-owned\nuser-cache/\n";
    if (existingIgnore) {
      await writeFile(ignore, userIgnore);
      git(root, "add", ".gitignore");
      git(root, "commit", "-qm", "user ignore");
    }
    const applied = await engine.applyProtection(root, hash(original));
    const relative = `.kkomkkom/protection/${applied.transactionId}/`;
    for (const args of [["ls-files", "--others", "--exclude-standard"], ["add", "--dry-run", "-A"]]) {
      assert.equal(git(root, ...args).toString().includes(relative), false, "private transaction must not be a staging candidate");
    }
    git(root, "add", "-A");
    assert.equal(git(root, "ls-files", "--", relative).length, 0, "no backup, metadata or ignore file is staged");
    await engine.restoreProtection(root, applied.transactionId);
    assert.equal(git(root, "ls-files", "--others", "--exclude-standard").toString().includes(relative), false);
    assert.deepEqual(await readFile(join(root, relative, "original")), original);
    if (existingIgnore) assert.equal(await readFile(ignore, "utf8"), userIgnore);
    else await assert.rejects(readFile(ignore), { code: "ENOENT" });
  }
});

test("protection backup preview warns about sensitive private transaction storage without disclosure", async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { next: "*" } }));
  const cli = new URL("../dist/cli.js", import.meta.url).pathname;
  for (const lang of ["en", "ko", "ja", "zh", "es"]) {
    const output = execFileSync(process.execPath, [cli, "--protect-sourcemaps", "--json", "--lang", lang], { cwd: root, encoding: "utf8" });
    const preview = JSON.parse(output);
    assert.match(preview.notes.join("\n"), /\.kkomkkom\/protection\/<TRANSACTION_ID>\//);
    assert.match(preview.notes.join("\n"), /credentials|인증정보|認証情報|凭据|credenciales/);
    assert.match(preview.notes.join("\n"), /Git/);
    assert.doesNotMatch(output, /MUST_NOT_PRINT|DO_NOT_PRINT|PRIVATE/);
  }
  assert.equal((await readdir(root)).includes(".kkomkkom"), false);
});

test("protection preserves all original Unix permission bits across apply and restore", async (t) => {
  const root = await fixture(t);
  const target = join(root, "next.config.js");
  await chmod(target, 0o1640);
  const applied = await engine.applyProtection(root, hash(original));
  assert.equal((await stat(target)).mode & 0o7777, 0o1640);
  await engine.restoreProtection(root, applied.transactionId);
  assert.equal((await stat(target)).mode & 0o7777, 0o1640);
});

test("protection final recheck refuses a concurrent chmod after the durable backup", async (t) => {
  const root = await fixture(t);
  const target = join(root, "next.config.js");
  await chmod(target, 0o640);
  let changed = false;
  const watcher = watch(root, (_event, name) => {
    if (!changed && name?.startsWith(".kkomkkom-protect-")) { chmodSync(target, 0o600); changed = true; }
  });
  try { await assert.rejects(engine.applyProtection(root, hash(original))); }
  finally { watcher.close(); }
  assert.equal(changed, true, "race must occur before replacement");
  assert.equal((await stat(target)).mode & 0o7777, 0o600);
  assert.deepEqual(await readFile(target), original);
});

test("protection restore refuses later user permission changes even when content hash matches", async (t) => {
  const root = await fixture(t);
  const target = join(root, "next.config.js");
  await chmod(target, 0o640);
  const applied = await engine.applyProtection(root, hash(original));
  const before = await readFile(target);
  await chmod(target, 0o600);
  await assert.rejects(engine.restoreProtection(root, applied.transactionId));
  assert.deepEqual(await readFile(target), before);
  assert.equal((await stat(target)).mode & 0o7777, 0o600);
});

test("protection refuses dirty/index/untracked targets, missing Git, and preview races", async (t) => {
  assert.equal(typeof engine.applyProtection, "function");
  for (const kind of ["worktree", "index", "untracked", "no-git", "hash"]) {
    const root = await fixture(t);
    const target = join(root, "next.config.js");
    if (kind === "worktree" || kind === "index") await writeFile(target, Buffer.concat([original, Buffer.from("// edit")]));
    if (kind === "index") git(root, "add", "next.config.js");
    if (kind === "untracked") git(root, "rm", "--cached", "next.config.js");
    if (kind === "no-git") await rm(join(root, ".git"), { recursive: true });
    const before = await readFile(target);
    await assert.rejects(engine.applyProtection(root, kind === "hash" ? "0".repeat(64) : hash(before)));
    assert.deepEqual(await readFile(target), before);
  }
});

test("protection rejects symlinked target/storage/ancestors and stale locks without deleting them", async (t) => {
  assert.equal(typeof engine.applyProtection, "function");
  for (const kind of ["target", "storage", "ancestor", "lock"]) {
    const root = await fixture(t);
    const outside = await mkdtemp("/tmp/opencode/kk-protect-outside-");
    t.after(() => rm(outside, { recursive: true, force: true }));
    if (kind === "target") {
      await writeFile(join(outside, "config"), original);
      await rm(join(root, "next.config.js"));
      await symlink(join(outside, "config"), join(root, "next.config.js"));
    } else if (kind === "storage") await symlink(outside, join(root, ".kkomkkom"));
    else if (kind === "lock") {
      await mkdir(join(root, ".kkomkkom", "protection"), { recursive: true, mode: 0o700 });
      await writeFile(join(root, ".kkomkkom", "protection", "lock"), "old-owner");
    } else await symlink(root, join(outside, "alias"));
    await assert.rejects(engine.applyProtection(kind === "ancestor" ? join(outside, "alias") : root, hash(original)));
    if (kind === "lock") assert.equal(await readFile(join(root, ".kkomkkom", "protection", "lock"), "utf8"), "old-owner");
  }
});

test("protection prevents concurrent transactions and refuses hidden Git edits", async (t) => {
  assert.equal(typeof engine.applyProtection, "function");
  const root = await fixture(t);
  const outcomes = await Promise.allSettled([
    engine.applyProtection(root, hash(original)), engine.applyProtection(root, hash(original)),
  ]);
  assert.equal(outcomes.filter((value) => value.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter((value) => value.status === "rejected").length, 1);
  for (const flag of ["--assume-unchanged", "--skip-worktree"]) {
    const hidden = await fixture(t);
    git(hidden, "update-index", flag, "next.config.js");
    await writeFile(join(hidden, "next.config.js"), Buffer.concat([original, Buffer.from("// hidden edit")]));
    const before = await readFile(join(hidden, "next.config.js"));
    await assert.rejects(engine.applyProtection(hidden, hash(before)));
    assert.deepEqual(await readFile(join(hidden, "next.config.js")), before);
  }
});

test("protection refuses forged applied hashes that would overwrite user changes", async (t) => {
  assert.equal(typeof engine.applyProtection, "function");
  const root = await fixture(t);
  const result = await engine.applyProtection(root, hash(original));
  const target = join(root, "next.config.js");
  const path = join(root, ".kkomkkom", "protection", result.transactionId, "metadata.json");
  const metadata = JSON.parse(await readFile(path, "utf8"));
  const userEdit = Buffer.from("module.exports = { productionBrowserSourceMaps: true, env: { USER: 'new' } }");
  await writeFile(target, userEdit);
  metadata.appliedHash = hash(userEdit);
  await writeFile(path, JSON.stringify(metadata));
  await assert.rejects(engine.restoreProtection(root, result.transactionId));
  assert.deepEqual(await readFile(target), userEdit);
});

test("protection refuses stale restore transactions after a later apply with identical bytes", async (t) => {
  const root = await fixture(t);
  const first = await engine.applyProtection(root, hash(original));
  await engine.restoreProtection(root, first.transactionId);
  const second = await engine.applyProtection(root, hash(original));
  const before = await readFile(join(root, "next.config.js"));
  await assert.rejects(engine.restoreProtection(root, first.transactionId));
  assert.deepEqual(await readFile(join(root, "next.config.js")), before);
  await engine.restoreProtection(root, second.transactionId);
  assert.deepEqual(await readFile(join(root, "next.config.js")), original);
});

test("protection refuses non-private transaction metadata without changing config", async (t) => {
  assert.equal(typeof engine.applyProtection, "function");
  const root = await fixture(t);
  const result = await engine.applyProtection(root, hash(original));
  const directory = join(root, ".kkomkkom", "protection");
  const transaction = join(directory, result.transactionId);
  // Transaction metadata is private just like the backup.
  await chmod(join(transaction, "metadata.json"), 0o644);
  const before = await readFile(join(root, "next.config.js"));
  await assert.rejects(engine.restoreProtection(root, result.transactionId));
  assert.deepEqual(await readFile(join(root, "next.config.js")), before);
  assert.equal((await readdir(directory)).includes("lock"), false);
});

test("protection restore refuses user edits, corrupt backup, malicious metadata and transaction IDs", async (t) => {
  assert.equal(typeof engine.applyProtection, "function");
  for (const kind of ["user-edit", "backup", "metadata-path", "metadata-root", "metadata-other-config", "metadata-large", "backup-symlink", "metadata-symlink"]) {
    const root = await fixture(t);
    const result = await engine.applyProtection(root, hash(original));
    const target = join(root, "next.config.js");
    const dir = join(root, ".kkomkkom", "protection", result.transactionId);
    if (kind === "user-edit") await writeFile(target, "// user later edit");
    else if (kind === "backup") await writeFile(join(dir, "original"), "corrupt");
    else if (kind.endsWith("symlink")) {
      const name = kind === "backup-symlink" ? "original" : "metadata.json";
      const content = await readFile(join(dir, name));
      await writeFile(join(root, "elsewhere"), content);
      await rm(join(dir, name));
      await symlink(join(root, "elsewhere"), join(dir, name));
    } else {
      const path = join(dir, "metadata.json");
      const metadata = JSON.parse(await readFile(path, "utf8"));
      if (kind === "metadata-path") metadata.file = "../next.config.js";
      if (kind === "metadata-root") metadata.root = "/tmp/opencode/another-root";
      if (kind === "metadata-other-config") {
        await writeFile(join(root, "next.config.cjs"), await readFile(target));
        metadata.file = "next.config.cjs";
      }
      await writeFile(path, kind === "metadata-large" ? " ".repeat(16385) : JSON.stringify(metadata));
    }
    const before = await readFile(target);
    await assert.rejects(engine.restoreProtection(root, result.transactionId));
    assert.deepEqual(await readFile(target), before);
    if (kind === "metadata-other-config") assert.deepEqual(await readFile(join(root, "next.config.cjs")), before);
    await assert.rejects(engine.restoreProtection(root, "../escape"));
  }
});
