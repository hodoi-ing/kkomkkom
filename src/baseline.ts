import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Baseline, Config, Diff, Finding, PageWeight, RouteDiff, WeightChange } from "./types.js";

const DIR = ".kkomkkom";
const FILE = "baseline.json";

async function baselinePath(root: string): Promise<string> {
  return join(root, DIR, FILE);
}

export async function loadBaseline(root: string): Promise<Baseline | null> {
  const path = await baselinePath(root);
  const raw = await readFile(path, "utf8").catch(() => null);
  if (raw === null) return null;

  try {
    const parsed = JSON.parse(raw);
    if (parsed?.version !== 1 || typeof parsed.routes !== "object" || typeof parsed.pages !== "object") {
      throw new Error("unknown shape");
    }
    return parsed as Baseline;
  } catch {
    await rename(path, `${path}.bak`).catch(() => {});
    return null;
  }
}

export async function saveBaseline(root: string, baseline: Baseline): Promise<void> {
  const dir = join(root, DIR);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, FILE), JSON.stringify(baseline, null, 2) + "\n", "utf8");
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
    };
  });

  const changedPages: WeightChange[] = Object.entries(pages)
    .map(([path, weight]) => {
      const from = previous?.pages[path]?.firstLoadJs;
      const deltaBytes = from === undefined ? 0 : weight.firstLoadJs - from;
      const deltaPercent = from ? (deltaBytes / from) * 100 : 0;
      const heavy =
        from !== undefined && deltaPercent >= thresholds.jsPercent && deltaBytes >= thresholds.jsBytes;
      return { path, from, to: weight.firstLoadJs, deltaBytes, deltaPercent, heavy };
    })
    .sort((a, b) => b.deltaBytes - a.deltaBytes);

  return { firstRun: !previous, routes, pages: changedPages };
}
