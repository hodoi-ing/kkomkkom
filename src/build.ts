import { spawn } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type { PageWeight } from "./types.js";

const BOX = /[┌├└│─┐┘┴┬╭╮╰╯]/g;
const ICONS = new Set(["○", "ƒ", "λ", "●", "◐", "◍", "◌"]);
const CHUNK = /\/_next\/(static\/chunks\/[^"']+\.js)/g;

function toBytes(value: string, unit: string): number {
  const n = Number.parseFloat(value);
  return Math.round(n * (unit.toLowerCase().startsWith("k") ? 1000 : 1));
}

/** Fallback for older Next versions that print a Size / First Load JS table. */
export function parseFirstLoadJs(output: string): Record<string, PageWeight> {
  const pages: Record<string, PageWeight> = {};

  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.replace(BOX, " ").trim();
    if (!line) continue;

    const tokens = line.split(/\s+/);
    if (ICONS.has(tokens[0]) && tokens.length > 1) tokens.shift();

    const route = tokens[0];
    if (!route?.startsWith("/")) continue;
    if (route.startsWith("/api")) continue;

    const match = line.match(/([\d.]+)\s*([kKM]?B)\s+([\d.]+)\s*([kKM]?B)\s*$/);
    if (!match) continue;

    pages[route] = { firstLoadJs: toBytes(match[3], match[4]) };
  }

  return pages;
}

async function sizeOf(root: string, chunk: string): Promise<number> {
  const file = join(root, ".next", chunk.replace(/^\/+/, ""));
  const info = await stat(file).catch(() => null);
  return info?.size ?? 0;
}

async function sumChunks(root: string, chunks: string[]): Promise<number> {
  const unique = [...new Set(chunks)];
  const sizes = await Promise.all(unique.map((chunk) => sizeOf(root, chunk)));
  return sizes.reduce((total, size) => total + size, 0);
}

async function findManifests(dir: string, out: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await findManifests(path, out);
    else if (entry.name === "page_client-reference-manifest.js") out.push(path);
  }
}

/**
 * Reads the build's own manifests and sums the JS each route actually ships.
 * Works with both Turbopack (Next 16+) and webpack builds, which no longer
 * print a size table in `next build` output.
 */
export async function measurePages(root: string): Promise<Record<string, PageWeight>> {
  const raw = await readFile(join(root, ".next", "build-manifest.json"), "utf8").catch(() => null);
  if (!raw) return {};

  let manifest: {
    rootMainFiles?: string[];
    polyfillFiles?: string[];
    pages?: Record<string, string[]>;
  };
  try {
    manifest = JSON.parse(raw);
  } catch {
    return {};
  }

  const shared = [...(manifest.rootMainFiles ?? []), ...(manifest.polyfillFiles ?? [])];
  const sharedBytes = await sumChunks(root, shared);
  const pages: Record<string, PageWeight> = {};

  const appDir = join(root, ".next", "server", "app");
  const manifests: string[] = [];
  await findManifests(appDir, manifests);

  for (const file of manifests) {
    const segments = relative(appDir, file).split(sep);
    segments.pop();
    const route = "/" + segments.filter((segment) => !segment.startsWith("(")).join("/");
    if (route.split("/").some((segment) => segment.startsWith("_"))) continue;

    const content = await readFile(file, "utf8");
    const chunks = [...content.matchAll(CHUNK)].map((match) => match[1]);
    const extra = await sumChunks(root, chunks.filter((chunk) => !shared.includes(chunk)));
    pages[route] = { firstLoadJs: sharedBytes + extra };
  }

  for (const [route, chunks] of Object.entries(manifest.pages ?? {})) {
    if (route.startsWith("/_") || route.startsWith("/api")) continue;
    const extra = await sumChunks(root, chunks.filter((chunk) => !shared.includes(chunk)));
    pages[route] = { firstLoadJs: sharedBytes + extra };
  }

  return pages;
}

export interface BuildResult {
  ok: boolean;
  output: string;
  pages: Record<string, PageWeight>;
}

export function runBuild(root: string): Promise<BuildResult> {
  return new Promise((resolve) => {
    const child = spawn("npx", ["next", "build"], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
    });

    let output = "";
    child.stdout?.on("data", (chunk) => (output += chunk));
    child.stderr?.on("data", (chunk) => (output += chunk));

    const timer = setTimeout(() => child.kill("SIGTERM"), 300_000);

    child.on("close", async (code) => {
      clearTimeout(timer);
      let pages: Record<string, PageWeight> = {};
      if (code === 0) {
        pages = await measurePages(root);
        if (Object.keys(pages).length === 0) pages = parseFirstLoadJs(output);
      }
      resolve({ ok: code === 0, output, pages });
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, output: output + String(error), pages: {} });
    });
  });
}
