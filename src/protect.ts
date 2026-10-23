import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import { dirname, join, parse, resolve, sep } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:net";
import ts from "typescript";
import { runBuild } from "./build.js";
import { runArtifactCheck } from "./artifacts.js";
import { readBody } from "./http.js";
import { startProductionServer, type DevServer } from "./server.js";
import type { CoverageSummary } from "./types.js";

const exec = promisify(execFile);
const CONFIG = /^next\.config\.(js|mjs|cjs|ts)$/;
const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const LIMIT = 1024 * 1024;
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

export class ProtectionError extends Error {
  transactionId?: string;
  configRestored = false;
  constructor(public readonly reason: string, public readonly configChanged = false) {
    super(`Protection refused: ${reason}.`);
  }
}
function refuse(reason: string): never { throw new ProtectionError(reason); }

export interface ProtectionPreview {
  status: "change" | "noop" | "unsupported";
  file?: string;
  expectedHash?: string;
  diff?: { before: "true"; after: "false"; line: number; column: number; start: number; end: number };
}

// Check every existing component, including ancestors of the supplied root.
async function safePath(path: string, directory = false): Promise<Stats> {
  const absolute = resolve(path);
  const base = parse(absolute).root;
  let current = base;
  let info = await lstat(base);
  const components = absolute.slice(base.length).split(sep).filter(Boolean);
  for (let index = 0; index < components.length; index++) {
    current = join(current, components[index]);
    info = await lstat(current);
    if (info.isSymbolicLink() || (index < components.length - 1 && !info.isDirectory())) refuse("unsafe-path");
  }
  if (directory ? !info.isDirectory() : !info.isFile()) refuse("unsafe-path");
  return info;
}

async function readSafe(path: string, limit = LIMIT) {
  const before = await safePath(path);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino || stat.size > limit) refuse("unsafe-file");
    const buffer = Buffer.alloc(limit + 1);
    let used = 0;
    while (used < buffer.length) {
      const { bytesRead } = await handle.read(buffer, used, buffer.length - used, null);
      if (bytesRead === 0) break;
      used += bytesRead;
    }
    const after = await handle.stat();
    if (used > limit || used !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) refuse("file-race");
    const final = await safePath(path);
    if (final.dev !== stat.dev || final.ino !== stat.ino) refuse("file-race");
    return { bytes: buffer.subarray(0, used), stat };
  } finally { await handle.close(); }
}

function objectExpression(node: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(node) || ts.isSatisfiesExpression(node) || ts.isAsExpression(node)) node = node.expression;
  return node;
}

function locate(file: string, bytes: Buffer): ProtectionPreview {
  const text = bytes.toString("utf8");
  const unsupported: ProtectionPreview = { status: "unsupported", file };
  if (!Buffer.from(text).equals(bytes)) return unsupported;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS);
  if ((source as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics.length) return unsupported;
  const candidates: ts.Expression[] = [];
  for (const statement of source.statements) {
    if (ts.isExportAssignment(statement) && !statement.isExportEquals) candidates.push(statement.expression);
    else if (ts.isExpressionStatement(statement) && ts.isBinaryExpression(statement.expression)) {
      const expression = statement.expression;
      const left = expression.left;
      if (expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken || !ts.isPropertyAccessExpression(left) ||
          !ts.isIdentifier(left.expression) || left.expression.text !== "module" || left.name.text !== "exports") return unsupported;
      candidates.push(expression.right);
    } else if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) ||
        (ts.isImportDeclaration(statement) && statement.importClause?.isTypeOnly) ||
        (ts.isExpressionStatement(statement) && ts.isStringLiteral(statement.expression) && statement.expression.text === "use strict")) continue;
    else return unsupported;
  }
  if (candidates.length !== 1) return unsupported;
  const object = objectExpression(candidates[0]);
  if (!ts.isObjectLiteralExpression(object)) return unsupported;
  const seen = new Set<string>();
  let token: ts.Expression | undefined;
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property) || ts.isComputedPropertyName(property.name)) return unsupported;
    if (!ts.isIdentifier(property.name) && !ts.isStringLiteral(property.name) && !ts.isNumericLiteral(property.name)) return unsupported;
    const name = property.name.text;
    if (seen.has(name)) return unsupported;
    seen.add(name);
    if (name === "productionBrowserSourceMaps") token = property.initializer;
  }
  if (!token || token.kind === ts.SyntaxKind.FalseKeyword) return { status: "noop", file };
  if (token.kind !== ts.SyntaxKind.TrueKeyword) return unsupported;
  const start = token.getStart(source);
  const { line, character } = source.getLineAndCharacterOfPosition(start);
  return { status: "change", file, expectedHash: digest(bytes), diff: {
    before: "true", after: "false", line: line + 1, column: character + 1, start, end: token.end,
  } };
}

async function inspect(root: string) {
  await safePath(root, true);
  const names = (await readdir(root)).filter((name) => /^next\.config\./.test(name));
  if (names.length === 0) return { preview: { status: "noop" } as ProtectionPreview };
  if (names.length !== 1 || !CONFIG.test(names[0])) return { preview: { status: "unsupported" } as ProtectionPreview };
  const file = names[0];
  const content = await readSafe(join(root, file));
  return { preview: locate(file, content.bytes), content };
}

export async function previewProtection(root: string): Promise<ProtectionPreview> {
  try { return (await inspect(resolve(root))).preview; }
  catch { throw new ProtectionError("unsafe-or-unreadable-config"); }
}

async function cleanTarget(root: string, file: string) {
  try {
    const options = { cwd: root, encoding: "utf8" as const, maxBuffer: 65536, timeout: 5000,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_LITERAL_PATHSPECS: "1" } };
    const tracked = await exec("git", ["ls-files", "--stage", "-z", "--", file], options);
    if (!/^100(?:644|755) [a-f0-9]+ 0\t/.test(tracked.stdout) || tracked.stdout.split("\0").length !== 2) refuse("git-untracked-or-conflict");
    const status = await exec("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", file], options);
    if (status.stdout !== "") refuse("git-dirty");
    // Git status can hide assume-unchanged/skip-worktree changes: compare both stored blobs.
    const head = await exec("git", ["rev-parse", `HEAD:./${file}`], options);
    const index = tracked.stdout.split(" ")[1];
    const actual = await exec("git", ["hash-object", "--no-filters", "--", file], options);
    if (head.stdout.trim() !== index || actual.stdout.trim() !== index) refuse("git-dirty");
  } catch { throw new ProtectionError("git-target-not-tracked-clean"); }
}

async function syncDirectory(path: string) {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

async function privateDirectory(path: string, create: boolean, strict = true) {
  await safePath(dirname(path), true);
  if (create) {
    try { await mkdir(path, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
  const stat = await safePath(path, true);
  if ((process.getuid && stat.uid !== process.getuid()) || (strict && (stat.mode & 0o077) !== 0)) refuse("unsafe-storage");
}

async function storage(root: string, create: boolean) {
  const base = join(root, ".kkomkkom");
  await privateDirectory(base, create, false);
  const directory = join(base, "protection");
  await privateDirectory(directory, create);
  return directory;
}

async function exclusiveFile(path: string, bytes: Buffer, mode = 0o600) {
  await safePath(dirname(path), true);
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  try { await handle.writeFile(bytes); await handle.chmod(mode); await handle.sync(); }
  finally { await handle.close(); }
}

async function locked<T>(directory: string, work: () => Promise<T>): Promise<T> {
  const path = join(directory, "lock");
  const token = Buffer.from(`${process.pid} ${randomUUID()}\n`);
  try { await exclusiveFile(path, token); }
  catch { throw new ProtectionError("transaction-locked-or-unsafe"); }
  const owner = await readSafe(path, 256);
  try { return await work(); }
  finally {
    try {
      const current = await readSafe(path, 256);
      if (current.stat.ino === owner.stat.ino && current.stat.dev === owner.stat.dev && current.bytes.equals(token)) await unlink(path);
    } catch { /* Never remove a replaced or unreadable lock. */ }
  }
}

async function activeTransaction(directory: string, transactionId: string) {
  const active = await readSafe(join(directory, "active"), 128);
  const [id, metadataHash] = active.bytes.toString("utf8").trimEnd().split(" ");
  if ((active.stat.mode & 0o077) !== 0 || (process.getuid && active.stat.uid !== process.getuid()) ||
      id !== transactionId || !metadataHash || !HASH.test(metadataHash) ||
      active.bytes.toString("utf8") !== `${transactionId} ${metadataHash}\n`) refuse("transaction-not-active");
  return { ...active, metadataHash };
}

async function releaseActive(directory: string, transactionId: string) {
  await activeTransaction(directory, transactionId);
  await unlink(join(directory, "active"));
  await syncDirectory(directory);
}

async function replace(root: string, file: string, expected: Awaited<ReturnType<typeof readSafe>>, bytes: Buffer, mode: number, before?: () => Promise<void>) {
  const temporary = join(root, `.kkomkkom-protect-${randomUUID()}.tmp`);
  let owned = false;
  try {
    await exclusiveFile(temporary, bytes, mode);
    owned = true;
    if (before) await before();
    const current = await readSafe(join(root, file));
    if (current.stat.dev !== expected.stat.dev || current.stat.ino !== expected.stat.ino || current.stat.mode !== expected.stat.mode ||
        current.stat.mtimeMs !== expected.stat.mtimeMs || current.stat.ctimeMs !== expected.stat.ctimeMs || !current.bytes.equals(expected.bytes)) refuse("config-changed-repreview");
    await safePath(root, true);
    await rename(temporary, join(root, file));
    owned = false;
    try { await syncDirectory(root); }
    catch { throw new ProtectionError("replacement-durability-failed", true); }
  } finally { if (owned) await unlink(temporary).catch(() => {}); }
}

interface Metadata {
  version: 1;
  transactionId: string;
  root: string;
  rootDev: number;
  rootIno: number;
  file: string;
  originalHash: string;
  appliedHash: string;
  mode: number;
}

function changedBytes(bytes: Buffer, preview: ProtectionPreview) {
  if (!preview.diff) refuse("no-supported-change");
  const text = bytes.toString("utf8");
  return Buffer.from(text.slice(0, preview.diff.start) + "false" + text.slice(preview.diff.end));
}

async function prepareApply(inputRoot: string, expectedHash: string) {
  if (typeof expectedHash !== "string" || !HASH.test(expectedHash)) refuse("expected-hash-required");
  const root = resolve(inputRoot);
  const initial = await inspect(root);
  if (initial.preview.status !== "change" || !initial.content || !initial.preview.file) refuse("no-supported-change");
  const { file } = initial.preview;
  if (initial.preview.expectedHash !== expectedHash) refuse("config-changed-repreview");
  await cleanTarget(root, file);
  const directory = await storage(root, true);
  return { root, directory, file };
}

export async function applyProtection(inputRoot: string, expectedHash: string) {
  const { root, directory, file } = await prepareApply(inputRoot, expectedHash);
  return locked(directory, () => applyLocked(root, directory, file, expectedHash));
}

async function applyLocked(root: string, directory: string, file: string, expectedHash: string) {
  try { await lstat(join(directory, "active")); refuse("active-transaction-conflict"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const current = await inspect(root);
  if (current.preview.status !== "change" || current.preview.file !== file || current.preview.expectedHash !== expectedHash || !current.content) refuse("config-changed-repreview");
  await cleanTarget(root, file);
  const transactionId = randomUUID();
  const transaction = join(directory, transactionId);
  await mkdir(transaction, { mode: 0o700 });
  await privateDirectory(transaction, false);
  await exclusiveFile(join(transaction, ".gitignore"), Buffer.from("*\n"));
  await syncDirectory(transaction);
  const original = current.content.bytes;
  const applied = changedBytes(original, current.preview);
  const rootStat = await safePath(root, true);
  const metadata: Metadata = { version: 1, transactionId, root, rootDev: rootStat.dev, rootIno: rootStat.ino,
    file, originalHash: digest(original), appliedHash: digest(applied), mode: current.content.stat.mode & 0o7777 };
  await exclusiveFile(join(transaction, "original"), original);
  if (!(await readSafe(join(transaction, "original"))).bytes.equals(original)) refuse("backup-verification-failed");
  const metadataBytes = Buffer.from(JSON.stringify(metadata) + "\n");
  await exclusiveFile(join(transaction, "metadata.json"), metadataBytes);
  await syncDirectory(transaction);
  await syncDirectory(directory);
  await syncDirectory(dirname(directory));
  await syncDirectory(root);
  await exclusiveFile(join(directory, "active"), Buffer.from(`${transactionId} ${digest(metadataBytes)}\n`));
  await syncDirectory(directory);
  try { await replace(root, file, current.content, applied, metadata.mode, () => cleanTarget(root, file)); }
  catch (error) {
    const failure = error instanceof ProtectionError ? error : new ProtectionError("apply-replacement-failed");
    failure.transactionId = transactionId;
    if (!failure.configChanged) await releaseActive(directory, transactionId);
    throw failure;
  }
  return { transactionId, file, originalHash: metadata.originalHash, appliedHash: metadata.appliedHash, configChanged: true };
}

export async function restoreProtection(inputRoot: string, transactionId: string) {
  if (typeof transactionId !== "string" || !ID.test(transactionId)) refuse("invalid-transaction-id");
  const root = resolve(inputRoot);
  await safePath(root, true);
  const directory = await storage(root, false);
  return locked(directory, () => restoreLocked(root, directory, transactionId));
}

async function restoreLocked(root: string, directory: string, transactionId: string) {
  const rootStat = await safePath(root, true);
  const active = await activeTransaction(directory, transactionId);
  const transaction = join(directory, transactionId);
  await privateDirectory(transaction, false);
  const raw = await readSafe(join(transaction, "metadata.json"), 16384);
  if (digest(raw.bytes) !== active.metadataHash) refuse("invalid-transaction-metadata");
  let metadata: Metadata;
  try { metadata = JSON.parse(raw.bytes.toString("utf8")); }
  catch { return refuse("invalid-transaction-metadata"); }
  if (!metadata || metadata.version !== 1 || metadata.transactionId !== transactionId || metadata.root !== root ||
      metadata.rootDev !== rootStat.dev || metadata.rootIno !== rootStat.ino || typeof metadata.file !== "string" || !CONFIG.test(metadata.file) ||
      typeof metadata.originalHash !== "string" || !HASH.test(metadata.originalHash) || typeof metadata.appliedHash !== "string" || !HASH.test(metadata.appliedHash) ||
      !Number.isInteger(metadata.mode) || metadata.mode < 0 || metadata.mode > 0o7777 || Object.keys(metadata).sort().join(",") !==
      "appliedHash,file,mode,originalHash,root,rootDev,rootIno,transactionId,version") refuse("invalid-transaction-metadata");
  const backup = await readSafe(join(transaction, "original"));
  if ((backup.stat.mode & 0o077) !== 0 || (raw.stat.mode & 0o077) !== 0 ||
      (process.getuid && (backup.stat.uid !== process.getuid() || raw.stat.uid !== process.getuid()))) refuse("unsafe-backup");
  if (digest(backup.bytes) !== metadata.originalHash) refuse("corrupt-backup");
  const preview = locate(metadata.file, backup.bytes);
  if (preview.status !== "change" || digest(changedBytes(backup.bytes, preview)) !== metadata.appliedHash) refuse("invalid-backup-change");
  const current = await readSafe(join(root, metadata.file));
  if (digest(current.bytes) !== metadata.appliedHash || (current.stat.mode & 0o7777) !== metadata.mode) refuse("config-edited-restore-refused");
  try {
    await replace(root, metadata.file, current, backup.bytes, metadata.mode);
    await releaseActive(directory, transactionId);
  } catch (error) {
    const failure = error instanceof ProtectionError ? error : new ProtectionError("restore-finalization-failed");
    failure.configRestored = (await readSafe(join(root, metadata.file)).catch(() => null))?.bytes.equals(backup.bytes) ?? false;
    throw failure;
  }
  return { transactionId, file: metadata.file, restored: true };
}

interface ProtectionVerification {
  build: "not-run" | "passed" | "failed";
  artifacts: "not-run" | "passed" | "failed";
  smoke: "not-run" | "passed" | "failed";
  cleanup: "not-run" | "passed" | "failed";
}

async function availablePort(): Promise<number> {
  const listener = createServer();
  return new Promise((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => {
      const address = listener.address();
      const port = typeof address === "object" && address ? address.port : 0;
      listener.close((error) => error ? reject(error) : port ? resolve(port) : reject(new ProtectionError("no-loopback-port")));
    });
  });
}

/** Build and smoke only after explicit apply; failures restore config, not build output. */
export async function applyAndVerifyProtection(inputRoot: string, expectedHash: string) {
  const controller = new AbortController();
  const interrupt = () => controller.abort(130);
  const terminate = () => controller.abort(143);
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  try {
    const { root, directory, file } = await prepareApply(inputRoot, expectedHash);
    const result = await locked(directory, () => verifyAppliedProtection(root, directory, file, expectedHash, controller.signal));
    return controller.signal.aborted ? { ...result, exitCode: controller.signal.reason as number } : result;
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
  }
}

async function verifyAppliedProtection(root: string, directory: string, file: string, expectedHash: string, signal: AbortSignal) {
  const verification: ProtectionVerification = { build: "not-run", artifacts: "not-run", smoke: "not-run", cleanup: "not-run" };
  let transaction: Awaited<ReturnType<typeof applyProtection>>;
  try { transaction = await applyLocked(root, directory, file, expectedHash); }
  catch (error) {
    if (!(error instanceof ProtectionError) || !error.configChanged || !error.transactionId) throw error;
    let rollback: "restored" | "refused" = "refused";
    let rollbackFailureReason: string | undefined;
    try { await restoreLocked(root, directory, error.transactionId); rollback = "restored"; }
    catch (restoreError) {
      rollbackFailureReason = restoreError instanceof ProtectionError ? restoreError.reason : "restore-error";
      if (restoreError instanceof ProtectionError && restoreError.configRestored) rollback = "restored";
    }
    return { status: "apply-failed" as const, exitCode: 1, transactionId: error.transactionId,
      configChanged: rollback !== "restored", verification, rollback, rollbackFailureReason, failureReason: error.reason, buildOutput: "may-have-changed" as const };
  }
  let server: DevServer | undefined;
  let failed = false;
  let failureReason: string | undefined;
  let artifactCoverage: CoverageSummary | undefined;
  try {
    verification.build = "failed";
    const build = await runBuild(root, { signal, ci: true });
    // Page-weight measurement is unrelated to the protection verification.
    if (!build.ok && build.failure !== "measure") refuse("production-build-failed");
    verification.build = "passed";
    verification.smoke = "failed";
    server = await startProductionServer(root, await availablePort(), { signal });
    if (!server.owned) refuse("production-not-owned");
    const response = await fetch(server.url, { redirect: "manual", signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) });
    const body = await readBody(response, LIMIT);
    if (response.status < 200 || response.status >= 400 || body.truncated) refuse("production-smoke-failed");
    verification.smoke = "passed";
    verification.artifacts = "failed";
    const inspection = await runArtifactCheck({ root, productionUrl: server.url });
    artifactCoverage = inspection.coverage;
    if (inspection.exitCode !== 0 || inspection.buildFailed || inspection.coverage.status !== "complete" ||
        inspection.extras.some((finding) => finding.rule === "artifact-source-map") ||
        inspection.coverage.checks.some((check) => check.status === "ignored" && check.reason?.startsWith("exception:artifact-source-map:"))) {
      refuse("artifact-verification-failed");
    }
    const current = await readSafe(join(root, transaction.file));
    if (signal.aborted) refuse("verification-cancelled");
    if (digest(current.bytes) !== transaction.appliedHash) refuse("config-changed-during-verification");
    verification.artifacts = "passed";
  } catch (error) { failed = true; failureReason = error instanceof ProtectionError ? error.reason : "verification-error"; }
  finally {
    if (server) {
      try { await server.stop(); verification.cleanup = "passed"; }
      catch { verification.cleanup = "failed"; failed = true; }
    }
  }
  if (signal.aborted) { failed = true; failureReason ??= "verification-cancelled"; }
  let rollback: "not-needed" | "restored" | "refused" = "not-needed";
  let rollbackFailureReason: string | undefined;
  if (failed) {
    rollback = "refused";
    try { await restoreLocked(root, directory, transaction.transactionId); rollback = "restored"; }
    catch (error) {
      rollbackFailureReason = error instanceof ProtectionError ? error.reason : "restore-error";
      if (error instanceof ProtectionError && error.configRestored) rollback = "restored";
    }
  }
  return { status: failed ? "verification-failed" as const : "applied" as const, exitCode: failed ? 1 : 0,
    transactionId: transaction.transactionId, file: transaction.file, configChanged: rollback !== "restored",
    verification, rollback, rollbackFailureReason, artifactCoverage, failureReason, buildOutput: "may-have-changed" as const };
}
