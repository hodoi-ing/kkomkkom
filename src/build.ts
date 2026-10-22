import { spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile, readdir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { nextEnv, resolveNextCli } from "./next.js";
import { installInterrupt, terminateGroup } from "./process.js";
import type { PageWeight } from "./types.js";

const BOX = /[┌├└│─┐┘┴┬╭╮╰╯]/g;
const ICONS = new Set(["○", "ƒ", "λ", "●", "◐", "◍", "◌"]);
const CHUNK = /(static\/chunks\/[^"']+\.js)/g;

export type MeasurementReason = "missing" | "read" | "directory" | "manifest";

export class MeasurementError extends Error {
  readonly reason: MeasurementReason;
  readonly chunk?: string;

  constructor(reason: MeasurementReason, chunk?: string) {
    super(`Measurement failed (${reason})${chunk ? `: ${chunk}` : ""}`);
    this.name = "MeasurementError";
    this.reason = reason;
    this.chunk = chunk;
  }
}

const UNITS: Record<string, number> = { b: 1, kb: 1000, mb: 1_000_000 };

function toBytes(value: string, unit: string): number {
  const n = Number.parseFloat(value);
  const scale = UNITS[unit.toLowerCase()];
  return Math.round(n * scale);
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

    const match = line.match(/([\d.]+)\s*([kKmM]?[bB])\s+([\d.]+)\s*([kKmM]?[bB])\s*$/);
    if (!match) continue;

    const bytes = toBytes(match[3], match[4]);
    if (!Number.isFinite(bytes)) continue;
    pages[route] = { firstLoadJs: bytes, method: "next-output" };
  }

  return pages;
}

function normalizeChunk(chunk: string): string {
  return chunk.replace(/^\/_next\//, "").replace(/^\/+/, "");
}

async function sizeOf(root: string, chunk: string): Promise<number> {
  const relativePath = normalizeChunk(chunk);
  if (!relativePath || relativePath.split("/").includes("..") || relativePath.startsWith("/")) {
    throw new MeasurementError("missing", chunk);
  }
  const file = join(root, ".next", relativePath);
  let info;
  try {
    info = await stat(file);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new MeasurementError(code === "ENOENT" ? "missing" : "read", chunk);
  }
  if (info.isDirectory()) throw new MeasurementError("directory", chunk);
  try {
    await access(file, constants.R_OK);
  } catch {
    throw new MeasurementError("read", chunk);
  }
  return info.size;
}

async function sumChunks(root: string, chunks: string[]): Promise<number> {
  const unique = new Map<string, string>();
  for (const chunk of chunks) unique.set(normalizeChunk(chunk), chunk);
  let total = 0;
  for (const chunk of unique.values()) total += await sizeOf(root, chunk);
  return total;
}

async function findManifests(dir: string, out: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
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
  let raw: string;
  try {
    raw = await readFile(join(root, ".next", "build-manifest.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }

  let manifest: {
    rootMainFiles?: string[];
    polyfillFiles?: string[];
    pages?: Record<string, string[]>;
  };
  try {
    manifest = JSON.parse(raw);
  } catch {
    throw new MeasurementError("manifest");
  }

  const shared = [...(manifest.rootMainFiles ?? []), ...(manifest.polyfillFiles ?? [])];
  const sharedKeys = new Set(shared.map(normalizeChunk));
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
    const extra = await sumChunks(root, chunks.filter((chunk) => !sharedKeys.has(normalizeChunk(chunk))));
    pages[route] = { firstLoadJs: sharedBytes + extra, method: "manifest-file" };
  }

  for (const [route, chunks] of Object.entries(manifest.pages ?? {})) {
    if (route.startsWith("/_") || route.startsWith("/api")) continue;
    const extra = await sumChunks(root, chunks.filter((chunk) => !sharedKeys.has(normalizeChunk(chunk))));
    pages[route] = { firstLoadJs: sharedBytes + extra, method: "manifest-file" };
  }

  return pages;
}

export type BuildFailure = "missing" | "spawn" | "compile" | "signal" | "timeout" | "internal" | "measure";

export interface BuildResult {
  ok: boolean;
  failure?: BuildFailure;
  output: string;
  pages: Record<string, PageWeight>;
}

export interface BuildOptions {
  /** An owning workflow handles process signals and waits for cleanup/rollback. */
  signal?: AbortSignal;
  timeoutMs?: number;
  stopTimeoutMs?: number;
  /** Test seam; defaults to node:child_process.spawn. */
  spawnImpl?: typeof spawn;
}

export function runBuild(root: string, options: BuildOptions = {}): Promise<BuildResult> {
  if (options.signal?.aborted) return Promise.resolve({ ok: false, failure: "signal", output: "Build cancelled.", pages: {} });
  const cli = resolveNextCli(root);
  if (!cli) {
    return Promise.resolve({
      ok: false,
      failure: "missing",
      output: "Next.js is not installed in this project.",
      pages: {},
    });
  }

  const spawnImpl = options.spawnImpl ?? spawn;
  let child: ChildProcess;
  try {
    child = spawnImpl(process.execPath, [cli, "build"], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      env: nextEnv(),
      windowsHide: true,
    });
  } catch {
    return Promise.resolve({
      ok: false,
      failure: "spawn",
      output: "The Next.js build process could not be started.",
      pages: {},
    });
  }

  return new Promise((resolve) => {
    let output = "";
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let handlingExit = false;
    let closed = false;
    let timer: NodeJS.Timeout | undefined;
    let resolveClosed = () => {};
    const closedWait = new Promise<void>((done) => {
      resolveClosed = done;
    });
    let cleanupPromise: Promise<boolean> | null = null;
    let removeInterrupt = () => {};

    const finish = (result: BuildResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      removeInterrupt();
      resolve(result);
    };

    const cleanup = () => {
      cleanupPromise ??= terminateGroup(child.pid, options.stopTimeoutMs ?? 1000, 1000);
      return cleanupPromise;
    };

    const handleExit = async (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled || timedOut || aborted || handlingExit) return;
      handlingExit = true;
      try {
        const cleaned = await cleanup();
        if (!closed) {
          // A descendant outside the group can keep the pipe open forever.
          await Promise.race([
            closedWait,
            new Promise<void>((done) => setTimeout(done, 500)),
          ]);
        }
        if (!cleaned) {
          finish({
            ok: false,
            failure: "internal",
            output: output + "\nThe Next.js build process group could not be stopped.",
            pages: {},
          });
          return;
        }
        if (signal !== null) {
          finish({ ok: false, failure: "signal", output: output + `\nbuild stopped by ${signal}`, pages: {} });
          return;
        }
        if (code !== 0) {
          finish({ ok: false, failure: "compile", output, pages: {} });
          return;
        }
        try {
          let pages = await measurePages(root);
          if (Object.keys(pages).length === 0) pages = parseFirstLoadJs(output);
          finish({ ok: true, output, pages });
        } catch (error) {
          if (error instanceof MeasurementError) {
            finish({ ok: false, failure: "measure", output: output + `\n${error.message}`, pages: {} });
          } else {
            finish({ ok: false, failure: "internal", output, pages: {} });
          }
        }
      } catch {
        finish({ ok: false, failure: "internal", output, pages: {} });
      }
    };

    child.stdout?.on("data", (chunk) => (output += chunk));
    child.stderr?.on("data", (chunk) => (output += chunk));

    timer = setTimeout(() => {
      timedOut = true;
      void (async () => {
        let cleaned = false;
        try {
          cleaned = await cleanup();
        } catch {
          // reported below as an incomplete cleanup
        }
        finish({
          ok: false,
          failure: "timeout",
          output: output + (cleaned
            ? "\nbuild timed out"
            : "\nbuild timed out; process cleanup incomplete"),
          pages: {},
        });
      })();
    }, options.timeoutMs ?? 300_000);

    child.once("exit", (code, signal) => {
      void handleExit(code, signal);
    });

    child.once("close", (code) => {
      closed = true;
      resolveClosed();
      void handleExit(code, null);
    });

    child.on("error", (error) => {
      finish({ ok: false, failure: "spawn", output: output + String(error), pages: {} });
    });

    if (options.signal) {
      const abort = () => {
        aborted = true;
        void cleanup().then((cleaned) => finish({ ok: false, failure: cleaned ? "signal" : "internal", output, pages: {} }),
          () => finish({ ok: false, failure: "internal", output, pages: {} }));
      };
      options.signal.addEventListener("abort", abort, { once: true });
      removeInterrupt = () => options.signal!.removeEventListener("abort", abort);
      if (options.signal.aborted) abort();
    } else removeInterrupt = installInterrupt(cleanup);
  });
}
