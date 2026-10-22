import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { KkomkkomError } from "./errors.js";
import type {
  Baseline, Config, Diff, Finding, MeasurementMethod, PageWeight, RouteDiff, Verdict, WeightChange,
} from "./types.js";

const DIR = ".kkomkkom";
const FILE = "baseline.json";
const LOCK = `${FILE}.lock`;
const LOCK_TIMEOUT_MS = 5000;

const VERDICTS = new Set<Verdict>(["locked", "exposed", "check", "public", "unknown", "error"]);
const METHODS = new Set<MeasurementMethod>(["manifest-file", "next-output"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidBaseline(value: unknown): value is Baseline {
  if (!isPlainObject(value)) return false;
  if (value.version !== 1 || typeof value.createdAt !== "string") return false;
  if (!isPlainObject(value.routes) || !isPlainObject(value.pages)) return false;

  for (const [path, route] of Object.entries(value.routes)) {
    if (!path.startsWith("/") || !isPlainObject(route)) return false;
    if (typeof route.verdict !== "string" || !VERDICTS.has(route.verdict as Verdict)) return false;
  }
  for (const [path, weight] of Object.entries(value.pages)) {
    if (!path.startsWith("/") || !isPlainObject(weight)) return false;
    const bytes = weight.firstLoadJs;
    if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return false;
    if (weight.method !== undefined &&
      (typeof weight.method !== "string" || !METHODS.has(weight.method as MeasurementMethod))) {
      return false;
    }
  }
  return true;
}

async function baselinePath(root: string): Promise<string> {
  return join(root, DIR, FILE);
}

export async function loadBaseline(root: string): Promise<Baseline | null> {
  const path = await baselinePath(root);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new KkomkkomError("errBaselineRead");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new KkomkkomError("errBaseline");
  }
  if (!isValidBaseline(parsed)) throw new KkomkkomError("errBaseline");
  return parsed;
}

async function acquireLock(dir: string, timeoutMs: number): Promise<() => Promise<void>> {
  const lock = join(dir, LOCK);
  // The token proves ownership on release; it also lets a human identify the
  // owner when inspecting a lock left behind by a killed process.
  const token = `${process.pid} ${randomUUID()}\n`;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    let handle;
    try {
      handle = await open(lock, "wx");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw new KkomkkomError("errBaselineWrite");
      }
      // Never delete a lock automatically: mtime cannot prove the owner died.
      // A stuck lock needs an explicit error and a human check.
      if (Date.now() >= deadline) throw new KkomkkomError("errBaselineLock");
      await delay(20);
      continue;
    }

    try {
      await handle.writeFile(token);
      await handle.close();
    } catch {
      await handle.close().catch(() => {});
      await unlink(lock).catch(() => {});
      throw new KkomkkomError("errBaselineWrite");
    }

    return async () => {
      // Release only the lock this save created, never a successor's lock.
      const current = await readFile(lock, "utf8").catch(() => null);
      if (current === token) await unlink(lock).catch(() => {});
    };
  }
}

export async function saveBaseline(
  root: string,
  baseline: Baseline,
  options: { lockTimeoutMs?: number } = {},
): Promise<void> {
  if (!isValidBaseline(baseline)) throw new KkomkkomError("errBaseline");

  const dir = join(root, DIR);
  try {
    await mkdir(dir, { recursive: true });
  } catch {
    throw new KkomkkomError("errBaselineWrite");
  }

  const release = await acquireLock(dir, options.lockTimeoutMs ?? LOCK_TIMEOUT_MS);
  const temp = join(dir, `.${FILE}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temp, JSON.stringify(baseline, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
    await rename(temp, join(dir, FILE));
  } catch {
    await unlink(temp).catch(() => {});
    throw new KkomkkomError("errBaselineWrite");
  } finally {
    await release();
  }
}

export function buildBaseline(findings: Finding[], pages: Record<string, PageWeight>): Baseline {
  const routes: Baseline["routes"] = {};
  for (const finding of findings) {
    routes[finding.path] = { verdict: finding.verdict };
  }
  return { version: 1, createdAt: new Date().toISOString(), routes, pages };
}

export function diffBaseline(
  previous: Baseline | null,
  findings: Finding[],
  pages: Record<string, PageWeight>,
  thresholds: Config["thresholds"],
): Diff {
  const routes: RouteDiff[] = findings.map((finding) => {
    const from = previous?.routes[finding.path]?.verdict;
    let state: RouteDiff["state"];
    if (!previous || from === undefined) state = "new";
    else if (from === finding.verdict) state = "same";
    else if (from === "exposed" && finding.verdict === "locked") state = "fixed";
    else state = "changed";

    return {
      path: finding.path,
      from,
      to: finding.verdict,
      state,
      detailKey: finding.detailKey,
      detailVars: finding.detailVars,
      status: finding.status,
      method: finding.method,
      policy: finding.policy,
      auth: finding.auth,
    };
  });

  const changedPages: WeightChange[] = Object.entries(pages)
    .map(([path, weight]) => {
      const previousWeight = previous?.pages[path];
      const from = previousWeight?.firstLoadJs;
      const fromMethod = previousWeight?.method;
      const toMethod = weight.method;
      // Only compare when both runs recorded the same measurement method. A
      // legacy baseline has no method, so its storage format is unknown: keep
      // it loadable, but never assume it used the current method.
      const comparable =
        fromMethod !== undefined && toMethod !== undefined && fromMethod === toMethod;
      const deltaBytes = from === undefined || !comparable ? 0 : weight.firstLoadJs - from;
      const deltaPercent = from && comparable ? (deltaBytes / from) * 100 : 0;
      const heavy =
        comparable && from !== undefined &&
        deltaPercent >= thresholds.jsPercent && deltaBytes >= thresholds.jsBytes;
      return {
        path,
        from,
        to: weight.firstLoadJs,
        deltaBytes,
        deltaPercent,
        heavy,
        comparable,
        ...(fromMethod ? { fromMethod } : {}),
        ...(toMethod ? { toMethod } : {}),
      };
    })
    .sort((a, b) => b.deltaBytes - a.deltaBytes);

  return { firstRun: !previous, routes, pages: changedPages };
}
