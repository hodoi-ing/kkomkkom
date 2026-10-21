import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import type { RouteInfo } from "./types.js";

const ROUTE_FILE = /^route\.(ts|tsx|js|jsx|mjs)$/;
const PAGE_FILE = /^page\.(ts|tsx|js|jsx|mjs)$/;
const SOURCE_FILE = /\.(ts|tsx|js|jsx|mjs)$/;
const SKIP_DIRS = new Set(["node_modules", ".next", "dist", "build", "__tests__", "__mocks__"]);

export async function findProjectRoot(cwd: string): Promise<string> {
  let dir = cwd;
  for (;;) {
    try {
      const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps.next) return dir;
    } catch {
      // keep walking up
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error("Next.js 프로젝트를 찾지 못했습니다. package.json에 next가 있는 폴더에서 실행해주세요.");
    }
    dir = parent;
  }
}

async function walk(dir: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await walk(path, out);
    else out.push(path);
  }
}

function segments(from: string, to: string): string[] {
  return relative(from, to).split(sep).filter(Boolean);
}

function appPath(root: string, file: string): string {
  const segs = segments(join(root, "app"), dirname(file))
    .filter((s) => !s.startsWith("(") && !s.startsWith("@"));
  return "/" + segs.join("/");
}

function pagesPath(root: string, file: string): string {
  const segs = segments(join(root, "pages"), dirname(file));
  const name = basename(file).replace(SOURCE_FILE, "");
  if (name !== "index") segs.push(name);
  return "/" + segs.join("/");
}

function isDynamic(path: string): boolean {
  return path.split("/").some((s) => s.includes("["));
}

export async function discoverRoutes(root: string): Promise<RouteInfo[]> {
  const files: string[] = [];
  await walk(join(root, "app"), files);
  await walk(join(root, "pages"), files);

  const routes: RouteInfo[] = [];
  for (const file of files) {
    const inApp = !relative(join(root, "app"), file).startsWith("..");
    const inPages = !relative(join(root, "pages"), file).startsWith("..");
    const name = basename(file);

    let kind: "api" | "page" | null = null;
    let path = "";

    if (inApp && ROUTE_FILE.test(name)) {
      kind = "api";
      path = appPath(root, file);
    } else if (inApp && PAGE_FILE.test(name)) {
      kind = "page";
      path = appPath(root, file);
    } else if (inPages && file.includes(`${sep}api${sep}`) && SOURCE_FILE.test(name)) {
      kind = "api";
      path = pagesPath(root, file);
    } else if (inPages && !file.includes(`${sep}api${sep}`) && SOURCE_FILE.test(name)) {
      const base = name.replace(SOURCE_FILE, "");
      if (base.startsWith("_")) continue;
      kind = "page";
      path = pagesPath(root, file);
    }

    if (!kind) continue;
    const source = kind === "api" ? await readFile(file, "utf8").catch(() => "") : "";
    routes.push({ path, file, kind, dynamic: isDynamic(path), source });
  }

  const seen = new Set<string>();
  return routes
    .filter((r) => {
      const key = `${r.kind}:${r.path}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}
