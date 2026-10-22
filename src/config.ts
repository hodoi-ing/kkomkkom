import { open, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { KkomkkomError } from "./errors.js";
import { ARTIFACT_RULE_IDS } from "./types.js";
import type { ArtifactException, ArtifactRuleId, Config, HttpMethod, RoutePolicies } from "./types.js";

const CONFIG_LIMIT = 1024 * 1024;

const METHODS: readonly HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];
const METHOD_SET = new Set<string>(METHODS);
const POLICY_SET = new Set(["public", "protected"]);

export const DEFAULT_CONFIG: Config = {
  ignoreRoutes: [],
  sampleParams: {},
  port: 3100,
  thresholds: { jsPercent: 15, jsBytes: 30000 },
  routePolicies: {},
  artifactExceptions: [],
};

function defaults(): Config {
  return {
    ignoreRoutes: [],
    sampleParams: {},
    port: DEFAULT_CONFIG.port,
    thresholds: { ...DEFAULT_CONFIG.thresholds },
    routePolicies: {},
    artifactExceptions: [],
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(field: string): never {
  throw new KkomkkomError("errConfigField", { field });
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) fail(field);
  return value.map((entry, index) => {
    if (typeof entry !== "string" || entry === "") fail(`${field}[${index}]`);
    return entry;
  });
}

function sampleParams(value: unknown): Config["sampleParams"] {
  if (!isPlainObject(value)) fail("sampleParams");
  const out: Config["sampleParams"] = {};
  for (const [route, params] of Object.entries(value)) {
    const field = `sampleParams[${JSON.stringify(route)}]`;
    if (!isPlainObject(params)) fail(field);
    const values: Record<string, string> = {};
    for (const [key, param] of Object.entries(params)) {
      if (typeof param !== "string") fail(`${field}.${key}`);
      values[key] = param;
    }
    out[route] = values;
  }
  return out;
}

function port(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65535) {
    fail("port");
  }
  return value;
}

function thresholds(value: unknown): Config["thresholds"] {
  if (value === undefined) return { ...DEFAULT_CONFIG.thresholds };
  if (!isPlainObject(value)) fail("thresholds");
  const out = { ...DEFAULT_CONFIG.thresholds };
  for (const key of ["jsPercent", "jsBytes"] as const) {
    if (key in value) {
      const number = value[key];
      if (typeof number !== "number" || !Number.isFinite(number) || number < 0) {
        fail(`thresholds.${key}`);
      }
      out[key] = number;
    }
  }
  return out;
}

function routePolicies(value: unknown): RoutePolicies {
  if (value === undefined) return {};
  if (!isPlainObject(value)) fail("routePolicies");
  const out: RoutePolicies = {};
  for (const [route, methods] of Object.entries(value)) {
    if (route === "" || !route.startsWith("/")) fail("routePolicies");
    const field = `routePolicies[${JSON.stringify(route)}]`;
    if (!isPlainObject(methods)) fail(field);
    const methodMap: Partial<Record<HttpMethod, "public" | "protected">> = {};
    for (const [method, policy] of Object.entries(methods)) {
      if (!METHOD_SET.has(method)) fail(`${field}.${method}`);
      if (typeof policy !== "string" || !POLICY_SET.has(policy)) fail(`${field}.${method}`);
      methodMap[method as HttpMethod] = policy as "public" | "protected";
    }
    out[route] = methodMap;
  }
  return out;
}

const ARTIFACT_RULES = new Set<string>(ARTIFACT_RULE_IDS);

function relativeArtifactPath(value: unknown, field: string): string {
  if (typeof value !== "string" || value === "") fail(field);
  const segments = value.split("/");
  if (value.startsWith("/") || /^[A-Za-z]:/.test(value) || value.includes("\\") ||
      segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    fail(field);
  }
  return value;
}

function artifactExceptions(value: unknown): ArtifactException[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail("artifactExceptions");
  return value.map((entry, index) => {
    const field = `artifactExceptions[${index}]`;
    if (!isPlainObject(entry)) fail(field);
    if (typeof entry.ruleId !== "string" || !ARTIFACT_RULES.has(entry.ruleId)) {
      fail(`${field}.ruleId`);
    }
    const file = relativeArtifactPath(entry.file, `${field}.file`);
    if (typeof entry.reason !== "string" || entry.reason.trim() === "") fail(`${field}.reason`);
    return { ruleId: entry.ruleId as ArtifactRuleId, file, reason: entry.reason };
  });
}

function inside(parent: string, child: string): boolean {
  const value = relative(parent, child);
  return value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value));
}

async function readConfigFile(root: string): Promise<string | null> {
  const path = join(root, "kkomkkom.config.json");
  let real: string;
  try {
    real = await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new KkomkkomError("errConfigRead");
  }
  let rootReal: string;
  try {
    rootReal = await realpath(root);
  } catch {
    throw new KkomkkomError("errConfigRead");
  }
  if (!inside(rootReal, real)) throw new KkomkkomError("errConfigRead");

  try {
    const handle = await open(real, "r");
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > CONFIG_LIMIT) throw new KkomkkomError("errConfigRead");
      const buffer = Buffer.alloc(info.size);
      let offset = 0;
      while (offset < info.size) {
        const { bytesRead } = await handle.read(buffer, offset, info.size - offset, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      if (offset !== info.size) throw new KkomkkomError("errConfigRead");
      const extra = Buffer.alloc(1);
      if ((await handle.read(extra, 0, 1, info.size)).bytesRead > 0) {
        throw new KkomkkomError("errConfigRead");
      }
      return buffer.toString("utf8");
    } finally {
      await handle.close().catch(() => undefined);
    }
  } catch (error) {
    if (error instanceof KkomkkomError) throw error;
    throw new KkomkkomError("errConfigRead");
  }
}

export async function loadConfig(root: string): Promise<Config> {
  const raw = await readConfigFile(root);
  if (raw === null) return defaults();

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new KkomkkomError("errConfig");
  }
  if (!isPlainObject(parsed)) throw new KkomkkomError("errConfig");

  const base = defaults();
  return {
    ignoreRoutes: parsed.ignoreRoutes === undefined
      ? base.ignoreRoutes
      : stringArray(parsed.ignoreRoutes, "ignoreRoutes"),
    sampleParams: parsed.sampleParams === undefined
      ? base.sampleParams
      : sampleParams(parsed.sampleParams),
    port: parsed.port === undefined ? base.port : port(parsed.port),
    thresholds: thresholds(parsed.thresholds),
    routePolicies: routePolicies(parsed.routePolicies),
    artifactExceptions: artifactExceptions(parsed.artifactExceptions),
  };
}
