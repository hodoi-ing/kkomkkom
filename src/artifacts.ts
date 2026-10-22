import { open, readdir, realpath, stat } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, sep } from "node:path";
import * as ts from "typescript";
import {
  envSecretValues, hasHighConfidenceSecret, isEnvEntry, maskSecrets, redactSecrets,
} from "./audit.js";
import { runBuild } from "./build.js";
import { loadConfig } from "./config.js";
import { KkomkkomError } from "./errors.js";
import { displayPath, isMissing } from "./fs.js";
import { summarizeCoverage, type RunResult } from "./run.js";
import type {
  ArtifactConfidence, ArtifactEvidenceKind, ArtifactRuleId, Config, CoverageCheck,
  ExtraFinding, ExtraSeverity,
} from "./types.js";
import type { MessageKey } from "./i18n.js";

const FILE_LIMIT = 1024 * 1024;
const TOTAL_LIMIT = 32 * 1024 * 1024;
const FILE_COUNT_LIMIT = 2000;
const SOURCE_DIRS = ["app", "src", "pages", "lib", "components", "utils"];
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const COMMENT_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const SKIP_DIRS = new Set([
  "node_modules", ".next", "dist", "build", "coverage", ".git", "fixtures",
  "test", "tests", "__tests__", "__mocks__",
]);
const MAP_REFERENCE = /sourceMappingURL=([^\s*'"]+)/g;
const SECRET_NAME =
  /NEXT_PUBLIC_[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PRIVATE|CREDENTIAL|API_KEY|ACCESS_KEY)[A-Z0-9_]*/;
const SERVER_ONLY = "server-only";

interface ScanState {
  files: number;
  bytes: number;
  countHit: boolean;
  budgetHit: boolean;
  reserved: Set<string>;
}

interface ScanFile {
  real: string;
  display: string;
}

interface ParsedSource {
  client: boolean;
  staticSpecifiers: string[];
  serverOnly: boolean;
  dynamicImport: boolean;
  dynamicVariable: boolean;
}

interface ConfigAnalysis {
  reason?: string;
  sourceMaps?: boolean;
}

interface MaskContext {
  values: string[];
  complete: boolean;
}

export interface ArtifactRunOptions {
  root: string;
  fresh?: boolean;
  strict?: boolean;
}

function inside(parent: string, child: string): boolean {
  const value = relative(parent, child);
  return value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value));
}

function add(
  findings: Map<string, ExtraFinding>,
  finding: ExtraFinding,
  key = `${finding.rule}:${finding.file}`,
): void {
  const previous = findings.get(key);
  if (previous === undefined || rank(finding.severity) < rank(previous.severity)) {
    findings.set(key, finding);
  }
}

function rank(severity: ExtraSeverity): number {
  return severity === "critical" ? 0 : severity === "warning" ? 1 : 2;
}

function artifact(
  rule: ArtifactRuleId,
  file: string,
  evidenceKind: ArtifactEvidenceKind,
  confidence: ArtifactConfidence,
  severity: ExtraSeverity,
  messageKey: MessageKey,
  messageVars: Record<string, string | number>,
  id = `${rule}:${file}`,
): ExtraFinding {
  return { id, severity, messageKey, messageVars, rule, file, evidenceKind, confidence };
}

function failure(
  coverage: CoverageCheck[],
  display: string | undefined,
  reason: string,
): void {
  coverage.push({
    rule: "artifacts",
    ...(display === undefined ? {} : { path: display }),
    status: "failed",
    reason,
  });
}

function unsupported(
  coverage: CoverageCheck[],
  reason: string,
  display?: string,
): void {
  coverage.push({
    rule: "artifacts",
    ...(display === undefined ? {} : { path: display }),
    status: "unsupported",
    reason,
  });
}

function staticOnly(coverage: CoverageCheck[], reason: string, display?: string): void {
  coverage.push({
    rule: "artifacts",
    ...(display === undefined ? {} : { path: display }),
    status: "static-only",
    reason,
  });
}

function reserve(real: string, state: ScanState, coverage: CoverageCheck[]): boolean {
  if (state.reserved.has(real)) return true;
  if (state.files >= FILE_COUNT_LIMIT) {
    if (!state.countHit) {
      state.countHit = true;
      failure(coverage, undefined, "count-limit");
    }
    return false;
  }
  state.reserved.add(real);
  state.files += 1;
  return true;
}

function errorReason(error: unknown): string {
  return (error as NodeJS.ErrnoException)?.code === "ELOOP" ? "symlink-loop" : "read";
}

async function directoryState(
  path: string,
  display: string,
  coverage: CoverageCheck[],
): Promise<"yes" | "no" | "error"> {
  try {
    return (await stat(path)).isDirectory() ? "yes" : "no";
  } catch (error) {
    if (isMissing(error)) return "no";
    failure(coverage, display, errorReason(error));
    return "error";
  }
}

export function rangeChangeReason(initial: number, read: number, final: number): string | null {
  if (final > initial) return "file-grew";
  if (final < initial) return "file-shrunk";
  if (read < initial) return "file-short";
  return null;
}

async function readBounded(
  real: string,
  display: string,
  state: ScanState,
  coverage: CoverageCheck[],
): Promise<string | null> {
  if (state.budgetHit || state.countHit) return null;
  let handle;
  try {
    handle = await open(real, "r");
  } catch (error) {
    failure(coverage, display, errorReason(error));
    return null;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) {
      failure(coverage, display, "read");
      return null;
    }
    if (info.size > FILE_LIMIT) {
      failure(coverage, display, "file-size");
      return null;
    }
    if (state.bytes + info.size > TOTAL_LIMIT) {
      state.budgetHit = true;
      failure(coverage, undefined, "total-budget");
      return null;
    }
    const initial = info.size;
    let buffer = Buffer.alloc(initial);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    // Keep reading past the stat size on the same handle so a growing file is observed, not guessed.
    for (;;) {
      if (offset > FILE_LIMIT) break;
      const remainingTotal = TOTAL_LIMIT - state.bytes - offset;
      if (remainingTotal < 0) {
        state.bytes += offset;
        state.budgetHit = true;
        failure(coverage, undefined, "total-budget");
        return null;
      }
      const chunk = Math.min(65536, FILE_LIMIT + 1 - offset, remainingTotal + 1);
      if (chunk <= 0) break;
      const extra = Buffer.alloc(chunk);
      const { bytesRead } = await handle.read(extra, 0, chunk, offset);
      if (bytesRead === 0) break;
      if (state.bytes + offset + bytesRead > TOTAL_LIMIT) {
        state.bytes += offset + bytesRead;
        state.budgetHit = true;
        failure(coverage, undefined, "total-budget");
        return null;
      }
      if (offset + bytesRead > buffer.length) {
        const grown = Buffer.alloc(offset + bytesRead);
        buffer.copy(grown, 0, 0, offset);
        buffer = grown;
      }
      extra.copy(buffer, offset, 0, bytesRead);
      offset += bytesRead;
    }
    state.bytes += offset;
    if (offset > FILE_LIMIT) {
      failure(coverage, display, "file-size");
      return null;
    }
    const final = await handle.stat();
    const changed = rangeChangeReason(initial, offset, final.size);
    if (changed !== null) {
      failure(coverage, display, changed);
      return null;
    }
    const bytes = buffer.subarray(0, offset);
    if (bytes.includes(0)) return null;
    return bytes.toString("utf8");
  } catch (error) {
    failure(coverage, display, errorReason(error));
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function walk(
  dir: string,
  root: string,
  boundary: string,
  state: ScanState,
  coverage: CoverageCheck[],
  files: ScanFile[],
): Promise<void> {
  if (state.budgetHit || state.countHit) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    failure(coverage, displayPath(root, dir), errorReason(error));
    return;
  }
  for (const entry of entries) {
    if (state.budgetHit || state.countHit) return;
    const path = join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      let resolved: string;
      try {
        resolved = await realpath(path);
      } catch (error) {
        failure(coverage, displayPath(root, path), errorReason(error));
        continue;
      }
      if (!inside(root, resolved) || !inside(boundary, resolved)) {
        unsupported(coverage, "symlink-escape", displayPath(root, path));
        continue;
      }
      let info;
      try {
        info = await stat(resolved);
      } catch (error) {
        failure(coverage, displayPath(root, path), errorReason(error));
        continue;
      }
      if (info.isDirectory()) {
        unsupported(coverage, "symlink-directory", displayPath(root, path));
        continue;
      }
      if (info.isFile()) addFile(path, resolved);
      continue;
    }
    if (entry.isDirectory()) {
      await walk(path, root, boundary, state, coverage, files);
      continue;
    }
    if (entry.isFile()) addFile(path, path);
  }

  function addFile(path: string, real: string): void {
    if (!reserve(real, state, coverage)) return;
    files.push({ real, display: displayPath(root, path) });
  }
}

function sensitiveKind(display: string): string | null {
  const name = display.split("/").pop() ?? "";
  const segments = display.split("/");
  if (/^\.env(?:$|\.)/.test(name) && !/\.(?:example|sample|template)$/.test(name)) return "env";
  if (segments.includes(".git") || name === ".gitconfig") return "git";
  if (/\.(?:pem|key|p12|pfx|jks|keystore)$/i.test(name) || /^id_(?:rsa|dsa|ecdsa|ed25519)/.test(name)) {
    return "key";
  }
  if (/\.(?:sql|sqlite3?|db|dump)$/i.test(name)) return "database";
  if (/\.(?:bak|backup|old|orig|save|swp|tmp)$/i.test(name) || name.endsWith("~")) return "backup";
  if (/\.log(?:\.\d+)?$/i.test(name)) return "log";
  if (/\.(?:test|spec)\.[^.]+$/i.test(name) || segments.some((part) => part === "__tests__" || part === "test" || part === "tests")) {
    return "test";
  }
  if (/\.(?:zip|tar|tgz|gz|rar|7z)$/i.test(name)) return "archive";
  return null;
}

function isMapFile(display: string): boolean {
  return extname(display).toLowerCase() === ".map";
}

function basicSourceMap(value: Record<string, unknown>): { sourcesContent: boolean } | null {
  if (value.version !== 3 || !Array.isArray(value.sources) || typeof value.mappings !== "string") {
    return null;
  }
  return {
    sourcesContent: Array.isArray(value.sourcesContent)
      && value.sourcesContent.some((item) => typeof item === "string" && item.length > 0),
  };
}

function parseSourceMap(text: string): { sourcesContent: boolean } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const value = parsed as Record<string, unknown>;
  const basic = basicSourceMap(value);
  if (basic !== null) return basic;
  if (value.version !== 3 || !Array.isArray(value.sections) || value.sections.length === 0) {
    return null;
  }
  let sourcesContent = false;
  for (const section of value.sections) {
    if (section === null || typeof section !== "object" || Array.isArray(section)) return null;
    const entry = section as Record<string, unknown>;
    const offset = entry.offset;
    if (offset === null || typeof offset !== "object" || Array.isArray(offset)) return null;
    const { line, column } = offset as Record<string, unknown>;
    if (!Number.isInteger(line) || (line as number) < 0
      || !Number.isInteger(column) || (column as number) < 0) {
      return null;
    }
    if (entry.map !== undefined) {
      if (entry.map === null || typeof entry.map !== "object" || Array.isArray(entry.map)) return null;
      const nested = basicSourceMap(entry.map as Record<string, unknown>);
      if (nested === null) return null;
      sourcesContent ||= nested.sourcesContent;
    } else if (typeof entry.url !== "string" || entry.url === "") {
      return null;
    }
  }
  return { sourcesContent };
}

function parseInlineMap(target: string): { sourcesContent: boolean } | null {
  const comma = target.indexOf(",");
  if (comma < 0) return null;
  const metadata = target.slice("data:".length, comma);
  const data = target.slice(comma + 1);
  try {
    const text = /;base64/i.test(metadata)
      ? Buffer.from(data, "base64").toString("utf8")
      : decodeURIComponent(data);
    return parseSourceMap(text);
  } catch {
    return null;
  }
}

function safeMapTarget(raw: string): string | null {
  let value = raw.split(/[?#]/, 1)[0];
  try {
    value = decodeURIComponent(value);
  } catch {
    // Keep the raw target when percent-decoding fails.
  }
  value = value.split(/[?#]/, 1)[0];
  if (value === "") return null;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value) || value.startsWith("//")) {
    return "external-target";
  }
  if (value.startsWith("/") || value.startsWith("\\\\") || /^[A-Za-z]:[\\/]/.test(value)
    || value.split(/[\\/]/).includes("..")) {
    return "outside-boundary";
  }
  if (value.includes("@")) return "external-target";
  return value;
}

function cssComments(text: string): string[] {
  const comments: string[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"' || char === "'") {
      index += 1;
      while (index < text.length) {
        if (text[index] === "\\") {
          index += 2;
          continue;
        }
        if (text[index] === char) break;
        index += 1;
      }
      continue;
    }
    if (char === "/" && text[index + 1] === "*") {
      const end = text.indexOf("*/", index + 2);
      const stop = end < 0 ? text.length : end + 2;
      comments.push(text.slice(index, stop));
      index = stop - 1;
    }
  }
  return comments;
}

function commentsIn(text: string, display: string): string[] {
  const extension = extname(display).toLowerCase();
  if (extension === ".css") return cssComments(text);
  if (!COMMENT_EXTENSIONS.has(extension)) return [];
  const source = parseText(display, text);
  const ranges = new Map<number, ts.CommentRange>();
  const collect = (node: ts.Node): void => {
    for (const range of ts.getLeadingCommentRanges(text, node.pos) ?? []) ranges.set(range.pos, range);
    for (const range of ts.getTrailingCommentRanges(text, node.end) ?? []) ranges.set(range.pos, range);
    ts.forEachChild(node, collect);
  };
  collect(source);
  for (const range of ts.getLeadingCommentRanges(text, source.endOfFileToken.pos) ?? []) {
    ranges.set(range.pos, range);
  }
  return [...ranges.values()]
    .sort((a, b) => a.pos - b.pos)
    .map((range) => text.slice(range.pos, range.end));
}

function mapFinding(
  file: string,
  inline: boolean,
  sourcesContent: boolean,
): ExtraFinding {
  const messageKey: MessageKey = inline
    ? (sourcesContent ? "artifactSourceMapInlineContent" : "artifactSourceMapInline")
    : (sourcesContent ? "artifactSourceMapFileContent" : "artifactSourceMapFile");
  return artifact(
    "artifact-source-map", file, "artifact", "confirmed", "warning",
    messageKey, { file }, `artifact-source-map:${file}:${inline ? "inline" : "file"}`,
  );
}

function sourceMapFindings(
  text: string,
  file: string,
  coverage: CoverageCheck[],
): ExtraFinding[] {
  const findings: ExtraFinding[] = [];
  let inlineTarget: string | null = null;
  let reference: string | null = null;
  for (const comment of commentsIn(text, file)) {
    for (const match of comment.matchAll(MAP_REFERENCE)) {
      const target = match[1];
      if (target.toLowerCase().startsWith("data:")) {
        inlineTarget ??= target;
      } else {
        reference ??= safeMapTarget(target);
      }
    }
  }
  if (inlineTarget !== null) {
    const parsed = parseInlineMap(inlineTarget);
    if (parsed === null) {
      staticOnly(coverage, "invalid-inline-map", file);
    } else {
      findings.push(mapFinding(file, true, parsed.sourcesContent));
    }
  }
  if (reference !== null) {
    findings.push(artifact(
      "artifact-source-map", file, "artifact", "confirmed", "warning",
      "artifactSourceMapReference", { file, target: reference },
      `artifact-source-map:${file}:reference`,
    ));
  }
  return findings;
}

function scriptKind(file: string): ts.ScriptKind {
  const extension = extname(file).toLowerCase();
  if (extension === ".tsx") return ts.ScriptKind.TSX;
  if (extension === ".ts" || extension === ".mts" || extension === ".cts") return ts.ScriptKind.TS;
  if (extension === ".jsx") return ts.ScriptKind.JSX;
  return ts.ScriptKind.JS;
}

function parseText(file: string, text: string): ts.SourceFile {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(file));
}

function hasUseClient(file: ts.SourceFile): boolean {
  for (const statement of file.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression)) break;
    if (statement.expression.text === "use client") return true;
  }
  return false;
}

function runtimeSpecifier(node: ts.ImportDeclaration): string | null {
  if (node.importClause?.isTypeOnly === true) return null;
  const bindings = node.importClause?.namedBindings;
  if (node.importClause?.name === undefined && bindings !== undefined && ts.isNamedImports(bindings)
    && bindings.elements.length > 0 && bindings.elements.every((element) => element.isTypeOnly)) {
    return null;
  }
  return ts.isStringLiteralLike(node.moduleSpecifier) ? node.moduleSpecifier.text : null;
}

function runtimeExport(node: ts.ExportDeclaration): string | null {
  if (node.isTypeOnly) return null;
  if (node.exportClause !== undefined && ts.isNamedExports(node.exportClause)
    && node.exportClause.elements.length > 0
    && node.exportClause.elements.every((element) => element.isTypeOnly)) {
    return null;
  }
  return node.moduleSpecifier !== undefined && ts.isStringLiteralLike(node.moduleSpecifier)
    ? node.moduleSpecifier.text
    : null;
}

function isServerOnly(specifier: string): boolean {
  return specifier === SERVER_ONLY || specifier.startsWith(`${SERVER_ONLY}/`);
}

function isLocalSpecifier(specifier: string): boolean {
  return specifier.startsWith(".") || specifier.startsWith("@/") || specifier.startsWith("~/")
    || specifier.startsWith("/") || isAbsolute(specifier);
}

function sourceInfo(file: string, text: string): ParsedSource {
  const source = parseText(file, text);
  const parsed: ParsedSource = {
    client: hasUseClient(source),
    staticSpecifiers: [],
    serverOnly: false,
    dynamicImport: false,
    dynamicVariable: false,
  };

  for (const statement of source.statements) {
    let specifier: string | null = null;
    if (ts.isImportDeclaration(statement)) {
      specifier = runtimeSpecifier(statement);
    } else if (ts.isExportDeclaration(statement)) {
      specifier = runtimeExport(statement);
    } else if (ts.isImportEqualsDeclaration(statement) && !statement.isTypeOnly
      && ts.isExternalModuleReference(statement.moduleReference)
      && ts.isStringLiteralLike(statement.moduleReference.expression)) {
      specifier = statement.moduleReference.expression.text;
    }
    if (specifier === null) continue;
    parsed.staticSpecifiers.push(specifier);
    if (isServerOnly(specifier)) parsed.serverOnly = true;
  }

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const argument = node.arguments[0];
      if (argument !== undefined && ts.isStringLiteralLike(argument)) {
        if (isLocalSpecifier(argument.text)) parsed.dynamicImport = true;
      } else {
        parsed.dynamicVariable = true;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return parsed;
}

function staticPropertyName(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
  if (ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) return name.text;
  return null;
}

function unwrapConfig(expression: ts.Expression): ts.Expression {
  let current = expression;
  for (;;) {
    if (ts.isParenthesizedExpression(current) || ts.isAsExpression(current)
      || ts.isSatisfiesExpression(current) || ts.isTypeAssertionExpression(current)
      || ts.isNonNullExpression(current)) {
      current = current.expression;
      continue;
    }
    return current;
  }
}

function isModuleExports(expression: ts.Expression): boolean {
  return ts.isPropertyAccessExpression(expression)
    && ts.isIdentifier(expression.expression)
    && expression.expression.text === "module"
    && expression.name.text === "exports";
}

function analyzeConfigText(file: string, text: string): ConfigAnalysis {
  const source = parseText(file, text);
  const candidates: ts.Expression[] = [];
  for (const statement of source.statements) {
    if (ts.isExportAssignment(statement)) {
      candidates.push(statement.expression);
      continue;
    }
    if (ts.isExpressionStatement(statement) && ts.isBinaryExpression(statement.expression)
      && statement.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && isModuleExports(statement.expression.left)) {
      candidates.push(statement.expression.right);
    }
  }
  if (candidates.length === 0) return { reason: "config-unresolved" };
  if (candidates.length > 1) return { reason: "multiple-exports" };

  const value = unwrapConfig(candidates[0]);
  if (!ts.isObjectLiteralExpression(value)) return { reason: "config-wrapper" };

  let sourceMaps = false;
  const seen = new Set<string>();
  for (const property of value.properties) {
    if (ts.isSpreadAssignment(property)) return { reason: "config-spread" };
    if (ts.isComputedPropertyName(property.name)) return { reason: "config-unresolved" };
    const name = staticPropertyName(property.name);
    if (name === null) continue;
    if (name !== "distDir" && name !== "output" && name !== "productionBrowserSourceMaps") {
      continue;
    }
    if (seen.has(name)) return { reason: "config-duplicate" };
    seen.add(name);

    if (ts.isShorthandPropertyAssignment(property)) {
      if (name === "distDir") return { reason: "custom-distDir" };
      if (name === "output") return { reason: "output-unresolved" };
      return { reason: "config-unresolved" };
    }
    if (!ts.isPropertyAssignment(property)) return { reason: "config-unresolved" };

    const setting = unwrapConfig(property.initializer);
    if (name === "distDir") {
      if (!ts.isStringLiteralLike(setting)) return { reason: "config-unresolved" };
      if (setting.text !== ".next") return { reason: "custom-distDir" };
      continue;
    }
    if (name === "output") {
      if (!ts.isStringLiteralLike(setting)) return { reason: "output-unresolved" };
      if (setting.text === "export") return { reason: "output-export" };
      if (setting.text === "standalone") return { reason: "output-standalone" };
      return { reason: "output-unresolved" };
    }
    if (setting.kind === ts.SyntaxKind.TrueKeyword) {
      sourceMaps = true;
    } else if (setting.kind !== ts.SyntaxKind.FalseKeyword) {
      return { reason: "config-unresolved" };
    }
  }
  return { sourceMaps };
}

async function detectSupport(
  root: string,
  state: ScanState,
  coverage: CoverageCheck[],
  findings: Map<string, ExtraFinding>,
): Promise<boolean> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    failure(coverage, undefined, "config-read");
    return false;
  }
  const configs = entries
    .filter((entry) => (entry.isFile() || entry.isSymbolicLink())
      && /^next\.config\.[^.]+$/.test(entry.name))
    .map((entry) => entry.name);
  if (configs.length === 0) return true;
  if (configs.length > 1) {
    unsupported(coverage, "multiple-config");
    return false;
  }

  const name = configs[0];
  const path = join(root, name);
  let real: string;
  try {
    real = await realpath(path);
  } catch (error) {
    failure(coverage, name, errorReason(error));
    return false;
  }
  if (!inside(root, real)) {
    unsupported(coverage, "symlink-escape", name);
    return false;
  }
  if (!reserve(real, state, coverage)) return false;
  const before = coverage.length;
  const text = await readBounded(real, name, state, coverage);
  if (text === null) {
    if (coverage.length === before) failure(coverage, name, "config-read");
    return false;
  }

  const analysis = analyzeConfigText(name, text);
  if (analysis.reason !== undefined) {
    unsupported(coverage, analysis.reason);
    return false;
  }
  if (analysis.sourceMaps === true) {
    add(findings, artifact(
      "artifact-source-map", name, "configuration", "confirmed", "warning",
      "artifactSourceMapConfig", { file: name },
    ));
  }
  return true;
}

async function checkBuildId(
  root: string,
  state: ScanState,
  coverage: CoverageCheck[],
): Promise<void> {
  const nextDir = join(root, ".next");
  const nextState = await directoryState(nextDir, displayPath(root, nextDir), coverage);
  if (nextState !== "yes") return;
  let realDir: string;
  try {
    realDir = await realpath(nextDir);
  } catch (error) {
    failure(coverage, ".next", errorReason(error));
    return;
  }
  if (!inside(root, realDir)) {
    unsupported(coverage, "symlink-escape", ".next");
    return;
  }
  const buildId = join(realDir, "BUILD_ID");
  let info;
  try {
    info = await stat(buildId);
  } catch (error) {
    if (isMissing(error)) {
      staticOnly(coverage, "build-id-missing", ".next");
    } else {
      failure(coverage, ".next/BUILD_ID", errorReason(error));
    }
    return;
  }
  if (!info.isFile()) {
    staticOnly(coverage, "build-id-missing", ".next");
    return;
  }
  let real: string;
  try {
    real = await realpath(buildId);
  } catch (error) {
    failure(coverage, ".next/BUILD_ID", errorReason(error));
    return;
  }
  if (!inside(root, real)) {
    unsupported(coverage, "symlink-escape", ".next/BUILD_ID");
    return;
  }
  if (!reserve(real, state, coverage)) return;
  const before = coverage.length;
  const text = await readBounded(real, ".next/BUILD_ID", state, coverage);
  if (text === null) {
    if (coverage.length === before) failure(coverage, ".next/BUILD_ID", "read");
    return;
  }
  staticOnly(coverage, "build-id-present", ".next/BUILD_ID");
}

async function scanBoundary(
  root: string,
  boundary: string,
  state: ScanState,
  coverage: CoverageCheck[],
  findings: Map<string, ExtraFinding>,
): Promise<boolean> {
  let boundaryReal: string;
  try {
    boundaryReal = await realpath(boundary);
  } catch (error) {
    failure(coverage, displayPath(root, boundary), errorReason(error));
    return false;
  }
  if (!inside(root, boundaryReal)) {
    unsupported(coverage, "symlink-escape", displayPath(root, boundary));
    return false;
  }
  const files: ScanFile[] = [];
  await walk(boundaryReal, root, boundaryReal, state, coverage, files);
  for (const file of files) {
    if (state.budgetHit || state.countHit) break;
    const name = file.display;
    const sensitive = isMapFile(name) ? null : sensitiveKind(name);
    const text = await readBounded(file.real, name, state, coverage);

    if (text === null) {
      if (sensitive !== null) {
        add(findings, artifact(
          "artifact-sensitive-file", name, "artifact", "uncertain", "warning",
          "artifactSensitiveFile", { file: name },
        ));
      }
      continue;
    }

    if (isMapFile(name)) {
      const parsed = parseSourceMap(text);
      if (parsed === null) {
        staticOnly(coverage, "invalid-map-format", name);
      } else {
        add(findings, mapFinding(name, false, parsed.sourcesContent));
      }
    } else {
      for (const finding of sourceMapFindings(text, name, coverage)) add(findings, finding);
    }

    if (sensitive !== null) {
      const confirmed = hasHighConfidenceSecret(text);
      add(findings, artifact(
        "artifact-sensitive-file", name, "artifact", confirmed ? "confirmed" : "uncertain",
        confirmed ? "critical" : "warning",
        confirmed ? "artifactSensitiveSecret" : "artifactSensitiveFile",
        { file: name },
      ));
      continue;
    }

    if (hasHighConfidenceSecret(text)) {
      add(findings, artifact(
        "artifact-client-secret", name, "artifact", "confirmed", "critical",
        "artifactClientSecret", { file: name },
      ));
      continue;
    }
    if (isScriptLike(name) && SECRET_NAME.test(text)) {
      add(findings, artifact(
        "artifact-client-secret", name, "artifact", "uncertain", "warning",
        "artifactClientNameSignal", { file: name },
      ));
    }
  }
  return !state.budgetHit && !state.countHit;
}

function isScriptLike(display: string): boolean {
  return /\.(?:js|mjs|cjs|css|html|json|map)$/i.test(display);
}

async function resolveModule(
  from: string,
  specifier: string,
  root: string,
  state: ScanState,
  coverage: CoverageCheck[],
): Promise<string | null> {
  const clean = specifier.split(/[?#]/, 1)[0];
  const base = join(dirname(from), clean);
  const candidates = [
    base,
    ...["ts", "tsx", "js", "jsx", "mjs", "cjs"].map((ext) => `${base}.${ext}`),
    ...["ts", "tsx", "js", "jsx", "mjs", "cjs"].map((ext) => join(base, `index.${ext}`)),
  ];
  for (const candidate of candidates) {
    let info;
    try {
      info = await stat(candidate);
    } catch (error) {
      if (isMissing(error)) continue;
      failure(coverage, displayPath(root, candidate), errorReason(error));
      return null;
    }
    if (!info.isFile()) continue;
    let real: string;
    try {
      real = await realpath(candidate);
    } catch (error) {
      failure(coverage, displayPath(root, candidate), errorReason(error));
      return null;
    }
    if (!inside(root, real)) {
      unsupported(coverage, "import-outside", displayPath(root, candidate));
      return null;
    }
    if (!reserve(real, state, coverage)) return null;
    return real;
  }
  return null;
}

async function collectSources(
  dir: string,
  root: string,
  state: ScanState,
  coverage: CoverageCheck[],
  out: string[],
  visited: Set<string>,
): Promise<void> {
  if (state.budgetHit || state.countHit) return;
  let real: string;
  try {
    real = await realpath(dir);
  } catch (error) {
    failure(coverage, displayPath(root, dir), errorReason(error));
    return;
  }
  if (!inside(root, real)) {
    unsupported(coverage, "source-outside", displayPath(root, dir));
    return;
  }
  if (visited.has(real)) {
    unsupported(coverage, "symlink-loop", displayPath(root, dir));
    return;
  }
  visited.add(real);

  let entries;
  try {
    entries = await readdir(real, { withFileTypes: true });
  } catch (error) {
    failure(coverage, displayPath(root, real), errorReason(error));
    return;
  }
  for (const entry of entries) {
    if (state.budgetHit || state.countHit) return;
    if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
    const path = join(real, entry.name);
    if (entry.isSymbolicLink()) {
      let resolved: string;
      try {
        resolved = await realpath(path);
      } catch (error) {
        failure(coverage, displayPath(root, path), errorReason(error));
        continue;
      }
      if (!inside(root, resolved)) {
        unsupported(coverage, "symlink-escape", displayPath(root, path));
        continue;
      }
      let info;
      try {
        info = await stat(resolved);
      } catch (error) {
        failure(coverage, displayPath(root, path), errorReason(error));
        continue;
      }
      if (info.isDirectory()) {
        await collectSources(resolved, root, state, coverage, out, visited);
      } else if (info.isFile() && SOURCE_EXTENSIONS.has(extname(resolved))) {
        if (!reserve(resolved, state, coverage)) return;
        out.push(resolved);
      }
      continue;
    }
    if (entry.isDirectory()) {
      await collectSources(path, root, state, coverage, out, visited);
    } else if (entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name))) {
      if (!reserve(path, state, coverage)) return;
      out.push(path);
    }
  }
}

async function inspectClientGraph(
  root: string,
  coverage: CoverageCheck[],
  state: ScanState,
): Promise<ExtraFinding[]> {
  if (state.budgetHit || state.countHit) return [];
  const sourceFiles: string[] = [];
  const visited = new Set<string>();
  for (const dir of SOURCE_DIRS) {
    const path = join(root, dir);
    const dirState = await directoryState(path, displayPath(root, path), coverage);
    if (dirState !== "yes") continue;
    let real: string;
    try {
      real = await realpath(path);
    } catch (error) {
      failure(coverage, displayPath(root, path), errorReason(error));
      continue;
    }
    if (!inside(root, real)) {
      unsupported(coverage, "source-outside", displayPath(root, path));
      continue;
    }
    await collectSources(real, root, state, coverage, sourceFiles, visited);
  }
  if (sourceFiles.length === 0) {
    if (!state.budgetHit && !state.countHit) unsupported(coverage, "source-missing");
    return [];
  }

  const entries: string[] = [];
  const cache = new Map<string, ParsedSource | null>();
  for (const file of sourceFiles) {
    if (state.budgetHit || state.countHit) break;
    const before = coverage.length;
    const text = await readBounded(file, displayPath(root, file), state, coverage);
    if (text === null) {
      if (coverage.length === before && !state.budgetHit && !state.countHit) {
        failure(coverage, displayPath(root, file), "read");
      }
      cache.set(file, null);
      continue;
    }
    const parsed = sourceInfo(file, text);
    cache.set(file, parsed);
    if (parsed.client) entries.push(file);
  }
  if (entries.length === 0) {
    if (!state.budgetHit && !state.countHit) {
      coverage.push({ rule: "artifacts", status: "checked", reason: "no-client-entries" });
    }
    return [];
  }

  const findings = new Map<string, ExtraFinding>();
  for (const entry of entries) {
    const client = displayPath(root, entry);
    const queue = [entry];
    const seen = new Set<string>();
    while (queue.length > 0) {
      if (state.budgetHit || state.countHit) break;
      const current = queue.shift()!;
      if (seen.has(current)) continue;
      seen.add(current);
      if (seen.size > 1000) {
        unsupported(coverage, "graph-limit", client);
        break;
      }
      let parsed = cache.get(current);
      if (parsed === undefined) {
        if (!reserve(current, state, coverage)) break;
        const before = coverage.length;
        const text = await readBounded(current, displayPath(root, current), state, coverage);
        if (text === null) {
          if (coverage.length === before && !state.budgetHit && !state.countHit) {
            failure(coverage, displayPath(root, current), "read");
          }
          cache.set(current, null);
          continue;
        }
        parsed = sourceInfo(current, text);
        cache.set(current, parsed);
      }
      if (parsed === null) continue;

      if (parsed.serverOnly) {
        const target = displayPath(root, current);
        add(findings, artifact(
          "artifact-server-boundary", client, "source-import", "confirmed", "warning",
          "artifactServerBoundary", { client, target },
          `artifact-server-boundary:${client}:${target}`,
        ));
      }
      if (parsed.dynamicImport) unsupported(coverage, "dynamic-import", displayPath(root, current));
      if (parsed.dynamicVariable) unsupported(coverage, "dynamic-import-variable", displayPath(root, current));

      for (const specifier of parsed.staticSpecifiers) {
        if (!isLocalSpecifier(specifier)) continue;
        if (specifier.startsWith("@/") || specifier.startsWith("~/") || specifier.startsWith("/")
          || isAbsolute(specifier)) {
          unsupported(coverage, "alias-import", displayPath(root, current));
          continue;
        }
        const before = coverage.length;
        const resolved = await resolveModule(current, specifier, root, state, coverage);
        if (resolved === null) {
          if (coverage.length === before && !state.budgetHit && !state.countHit) {
            unsupported(coverage, "unresolved-import", displayPath(root, current));
          }
          continue;
        }
        if (!seen.has(resolved)) queue.push(resolved);
      }
    }
  }
  if (!state.budgetHit && !state.countHit) {
    coverage.push({ rule: "artifacts", status: "checked", reason: "client-graph" });
  }
  return [...findings.values()];
}

function maskFreeText(text: string, values: readonly string[]): string {
  return maskSecrets(text, values)
    .replace(/sk_live_[A-Za-z0-9]+/g, "[redacted]")
    .replace(/sk-proj-[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/AKIA[0-9A-Z]+/g, "[redacted]")
    .replace(/ghp_[A-Za-z0-9]+/g, "[redacted]")
    .replace(/xox[baprs]-[A-Za-z0-9-]+/g, "[redacted]")
    .replace(/([?&](?:token|key|secret|password|passwd|sig|signature)=)[^&\s#]+/gi, "$1[redacted]")
    .replace(/(\/\/)[^/\s@]+@/g, "$1[redacted]@")
    .replace(/(\b(?:api[_-]?key|secret|token|password|passwd)\s*[:=]\s*)[^\s,;]+/gi, "$1[redacted]");
}

async function loadMaskValues(
  root: string,
  state: ScanState,
  coverage: CoverageCheck[],
): Promise<MaskContext> {
  let entries;
  try {
    entries = (await readdir(root, { withFileTypes: true })).filter(isEnvEntry);
  } catch {
    failure(coverage, undefined, "masking-context");
    return { values: [], complete: false };
  }
  const values = new Set<string>();
  let complete = true;
  for (const entry of entries) {
    if (state.budgetHit || state.countHit) {
      complete = false;
      break;
    }
    const real = await realpath(join(root, entry.name)).catch(() => null);
    if (real === null) {
      failure(coverage, entry.name, "read");
      complete = false;
      continue;
    }
    if (!inside(root, real)) {
      unsupported(coverage, "symlink-escape", entry.name);
      complete = false;
      continue;
    }
    if (!reserve(real, state, coverage)) {
      complete = false;
      continue;
    }
    const before = coverage.length;
    const text = await readBounded(real, entry.name, state, coverage);
    if (text === null) {
      if (coverage.length === before) failure(coverage, entry.name, "read");
      complete = false;
      continue;
    }
    for (const value of envSecretValues(text)) values.add(value);
  }
  return { values: [...values], complete };
}

function applyExceptions(
  findings: ExtraFinding[],
  config: Config,
  coverage: CoverageCheck[],
  mask: MaskContext,
): ExtraFinding[] {
  if (config.artifactExceptions.length === 0) return findings;
  const exceptions = new Map(
    config.artifactExceptions.map((entry) => [`${entry.ruleId}:${entry.file}`, entry]),
  );
  const kept: ExtraFinding[] = [];
  for (const finding of findings) {
    const exception = finding.rule && finding.file
      ? exceptions.get(`${finding.rule}:${finding.file}`)
      : undefined;
    if (exception) {
      const reason = mask.complete ? maskFreeText(exception.reason, mask.values) : "unconfirmed";
      coverage.push({
        rule: "artifacts",
        path: finding.file,
        status: "ignored",
        reason: `exception:${exception.ruleId}:${reason}`,
      });
      continue;
    }
    kept.push(finding);
  }
  return kept;
}

async function inspect(
  root: string,
  config: Config,
  coverage: CoverageCheck[],
  fresh: boolean,
): Promise<ExtraFinding[]> {
  const findings = new Map<string, ExtraFinding>();
  const state: ScanState = {
    files: 0, bytes: 0, countHit: false, budgetHit: false, reserved: new Set(),
  };
  const mask = await loadMaskValues(root, state, coverage);
  const scanStatic = await detectSupport(root, state, coverage, findings);
  await checkBuildId(root, state, coverage);

  let publicScanned = false;
  let staticScanned = false;

  const publicDir = join(root, "public");
  const publicState = await directoryState(publicDir, displayPath(root, publicDir), coverage);
  if (publicState === "yes") {
    publicScanned = await scanBoundary(root, publicDir, state, coverage, findings);
  }

  if (scanStatic) {
    const staticDir = join(root, ".next", "static");
    const staticState = await directoryState(staticDir, displayPath(root, staticDir), coverage);
    if (staticState === "yes") {
      staticScanned = await scanBoundary(root, staticDir, state, coverage, findings);
      if (staticScanned) {
        coverage.push({
          rule: "artifacts",
          status: fresh ? "checked" : "static-only",
          reason: fresh ? "fresh-build" : "build-freshness-unknown",
        });
      }
    } else if (staticState === "no") {
      unsupported(coverage, "missing-output");
    }
  }

  if (publicScanned || staticScanned) {
    const reason = publicScanned && staticScanned
      ? "public+static"
      : staticScanned ? "static" : "public";
    coverage.push({ rule: "artifacts", status: "checked", reason });
  }

  for (const finding of await inspectClientGraph(root, coverage, state)) {
    add(findings, finding, `${finding.rule}:${finding.file}`);
  }

  const sorted = [...findings.values()]
    .sort((a, b) => rank(a.severity) - rank(b.severity) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const masked = sorted.map((finding) => {
    const target = finding.messageVars?.target;
    if (typeof target !== "string") return finding;
    return {
      ...finding,
      messageVars: { ...finding.messageVars, target: maskFreeText(target, mask.values) },
    };
  });
  return applyExceptions(masked, config, coverage, mask);
}

export async function runArtifactCheck(options: ArtifactRunOptions): Promise<RunResult> {
  const config = await loadConfig(options.root);
  const coverage: CoverageCheck[] = [];
  let buildFailed = false;
  let buildTail = "";
  let fresh = false;

  if (options.fresh === true) {
    const build = await runBuild(options.root);
    if (build.ok || build.failure === "measure") {
      fresh = true;
      coverage.push({ rule: "build", status: "checked", reason: "build" });
    } else if (build.failure === undefined || build.failure === "compile") {
      buildFailed = true;
      coverage.push({ rule: "build", status: "failed", reason: "compile" });
      buildTail = await redactSecrets(options.root, build.output).catch(() => "");
    } else {
      const tail = await redactSecrets(options.root, build.output).catch(() => "");
      throw new KkomkkomError("errBuildRun", { reason: build.failure, log: tail });
    }
  }

  const root = await realpath(options.root);
  let extras: ExtraFinding[];
  if (buildFailed) {
    coverage.push({ rule: "artifacts", status: "failed", reason: "build" });
    extras = [];
  } else {
    extras = await inspect(root, config, coverage, fresh);
  }

  const summary = summarizeCoverage(coverage);
  const critical = extras.filter((extra) => extra.severity === "critical").length;
  const warnings = extras.filter((extra) => extra.severity === "warning").length;
  const exitCode = buildFailed || critical > 0 ||
    (options.strict === true && (warnings > 0 || summary.status !== "complete"))
    ? 1
    : 0;

  return {
    schemaVersion: 2,
    diff: { firstRun: false, routes: [], pages: [] },
    extras,
    coverage: summary,
    buildFailed,
    buildTail,
    exitCode,
  };
}
