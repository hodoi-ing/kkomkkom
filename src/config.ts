import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "./types.js";

export const DEFAULT_CONFIG: Config = {
  ignoreRoutes: [],
  sampleParams: {},
  port: 3100,
  thresholds: { jsPercent: 15, jsBytes: 30000 },
};

export async function loadConfig(root: string): Promise<Config> {
  const raw = await readFile(join(root, "kkomkkom.config.json"), "utf8").catch(() => null);
  if (!raw) return DEFAULT_CONFIG;

  let parsed: Partial<Config>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("kkomkkom.config.json 형식이 올바르지 않습니다.");
  }

  return {
    ignoreRoutes: parsed.ignoreRoutes ?? DEFAULT_CONFIG.ignoreRoutes,
    sampleParams: parsed.sampleParams ?? DEFAULT_CONFIG.sampleParams,
    port: parsed.port ?? DEFAULT_CONFIG.port,
    thresholds: { ...DEFAULT_CONFIG.thresholds, ...parsed.thresholds },
  };
}
