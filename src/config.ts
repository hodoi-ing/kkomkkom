import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { KkomkkomError } from "./errors.js";
import type { Config, HttpMethod, RoutePolicies } from "./types.js";

const METHODS: readonly HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];
const METHOD_SET = new Set<string>(METHODS);
const POLICY_SET = new Set(["public", "protected"]);

export const DEFAULT_CONFIG: Config = {
  ignoreRoutes: [],
  sampleParams: {},
  port: 3100,
  thresholds: { jsPercent: 15, jsBytes: 30000 },
  routePolicies: {},
};

function defaults(): Config {
  return {
    ignoreRoutes: [],
    sampleParams: {},
    port: DEFAULT_CONFIG.port,
    thresholds: { ...DEFAULT_CONFIG.thresholds },
    routePolicies: {},
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

export async function loadConfig(root: string): Promise<Config> {
  let raw: string;
  try {
    raw = await readFile(join(root, "kkomkkom.config.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaults();
    throw new KkomkkomError("errConfigRead");
  }

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
  };
}
