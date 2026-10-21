import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative, sep } from "node:path";
import { hasAuthSignal, matchesGlob } from "./classify.js";
import type { Config, ExtraFinding, RouteInfo } from "./types.js";

export interface AuditInput {
  root: string;
  baseUrl: string;
  routes: RouteInfo[];
  config: Config;
}

const ENV_EXAMPLES = new Set([".env.example", ".env.sample", ".env.template"]);
const SOURCE_DIRS = ["app", "pages", "src", "lib", "components", "utils"];
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const SKIP_DIRS = new Set([
  "node_modules", ".next", "dist", "build", "coverage", ".git", "fixtures",
  "test", "tests", "__tests__", "__mocks__",
]);
const PLACEHOLDER = /example|placeholder|your|xxx|dummy|changeme|test/i;
const PUBLIC_SECRET = /SECRET|TOKEN|PASSWORD|PASS|PRIVATE|CREDENTIAL|API_KEY|ACCESS_KEY/i;
const SECRET = /sk_live_[A-Za-z0-9]{16,}|sk-proj-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{36}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g;
const WRITE_EXPORT = /\bexport\s+(?:(?:async\s+)?function\s+|(?:const|let|var)\s+)(?:POST|PUT|PATCH|DELETE)\b/;
const WRITE_REEXPORT = /\bexport\s*\{[^}]*\b(?:POST|PUT|PATCH|DELETE)\b[^}]*\}/;
const WRITE_METHOD = /\b(?:req|request)\.method\s*={2,3}\s*["'](?:POST|PUT|PATCH|DELETE)["']/;
const WRITE_CASE = /\bcase\s*["'](?:POST|PUT|PATCH|DELETE)["']\s*:/;

function git(root: string, args: string[]): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    execFile("git", ["-C", root, ...args], { timeout: 5000 }, (error, stdout) => {
      resolve({ code: error ? (typeof error.code === "number" ? error.code : null) : 0, stdout });
    });
  });
}

async function scanSources(dir: string, files: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await scanSources(path, files);
    else if (entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name))) files.push(path);
  }
}

async function auditSecrets(root: string): Promise<ExtraFinding[]> {
  const findings: ExtraFinding[] = [];
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const envFiles = entries.filter((entry) =>
    (entry.isFile() || entry.isSymbolicLink()) && entry.name.startsWith(".env") && !ENV_EXAMPLES.has(entry.name),
  );
  const repo = await git(root, ["rev-parse", "--is-inside-work-tree"]);
  const inGit = repo.code === 0 && repo.stdout.trim() === "true";
  const publicKeys = new Set<string>();

  for (const entry of envFiles) {
    const file = entry.name;
    if (inGit) {
      const tracked = await git(root, ["ls-files", "--error-unmatch", file]);
      if (tracked.code === 0) {
        findings.push({ id: `env-tracked:${file}`, severity: "critical",
          messageKey: "extraEnvTracked", messageVars: { file } });
      } else if (tracked.code === 1) {
        const ignored = await git(root, ["check-ignore", "-q", file]);
        if (ignored.code === 1) {
          findings.push({ id: `env-not-ignored:${file}`, severity: "warning",
            messageKey: "extraEnvNotIgnored", messageVars: { file } });
        }
      }
    }

    const content = await readFile(join(root, file), "utf8").catch(() => "");
    for (const line of content.split(/\r?\n/)) {
      const match = line.trim().match(/^(?:export\s+)?([A-Za-z_][\w]*)\s*=\s*(.*)$/);
      if (!match) continue;
      const key = match[1];
      let value = match[2].trim();
      if (value.startsWith('"') || value.startsWith("'")) {
        value = value.match(/^(["'])(.*?)\1/)?.[2] ?? "";
      } else {
        value = value.split("#", 1)[0].trim();
      }
      if (key.startsWith("NEXT_PUBLIC_") && PUBLIC_SECRET.test(key) &&
          value.trim() !== "" && !PLACEHOLDER.test(value)) publicKeys.add(key);
    }
  }

  for (const key of publicKeys) {
    findings.push({ id: `public-secret:${key}`, severity: "warning",
      messageKey: "extraPublicSecret", messageVars: { key } });
  }

  const files: string[] = [];
  for (const dir of SOURCE_DIRS) await scanSources(join(root, dir), files);
  for (const entry of entries) {
    if (entry.isFile() && /^(middleware|next\.config)\./.test(entry.name) &&
        SOURCE_EXTENSIONS.has(extname(entry.name))) files.push(join(root, entry.name));
  }
  for (const path of files) {
    const content = await readFile(path, "utf8").catch(() => "");
    const file = relative(root, path).split(sep).join("/");
    const lines = content.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      if (![...lines[index].matchAll(SECRET)].some((match) => !PLACEHOLDER.test(match[0]))) continue;
      const line = index + 1;
      findings.push({ id: `hardcoded-secret:${file}:${line}`, severity: "critical",
        messageKey: "extraHardcodedSecret", messageVars: { file, line } });
    }
  }
  return findings;
}

function auditWrites(routes: RouteInfo[], config: Config): ExtraFinding[] {
  return routes.filter((route) => route.kind === "api" &&
    !config.ignoreRoutes.some((pattern) => matchesGlob(route.path, pattern)) &&
    !hasAuthSignal(route.source) &&
    [WRITE_EXPORT, WRITE_REEXPORT, WRITE_METHOD, WRITE_CASE].some((pattern) => pattern.test(route.source)),
  ).map((route) => ({ id: `write-no-auth:${route.path}`, severity: "warning",
    messageKey: "extraWriteNoAuth", messageVars: { path: route.path } }));
}

async function smokePage(baseUrl: string, route: RouteInfo, config: Config): Promise<ExtraFinding | null> {
  const params = config.sampleParams[route.path];
  const path = route.path.replace(/\[\.{0,3}([^\]]+)\]/g, (match, key: string) => params?.[key] ?? match);
  try {
    const res = await fetch(baseUrl + path, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(8000),
      headers: { "user-agent": "kkomkkom/0.1" },
    });
    let error = res.status >= 500;
    if (res.status >= 200 && res.status < 300) {
      const body = (await res.text()).slice(0, 8192).toLowerCase();
      error = /__next_error__|application error|internal server error/.test(body);
    } else {
      await res.body?.cancel().catch(() => {});
    }
    if (error) return { id: `page-error:${route.path}`, severity: "warning",
      messageKey: "extraPageError", messageVars: { path: route.path, status: res.status } };
    return null;
  } catch {
    return { id: `page-timeout:${route.path}`, severity: "info",
      messageKey: "extraPageTimeout", messageVars: { path: route.path, seconds: 8 } };
  }
}

async function auditPages(input: AuditInput): Promise<ExtraFinding[]> {
  const queue = input.routes.filter((route) => route.kind === "page" &&
    !input.config.ignoreRoutes.some((pattern) => matchesGlob(route.path, pattern)) &&
    (!route.dynamic || input.config.sampleParams[route.path]),
  );
  const findings: ExtraFinding[] = [];
  await Promise.all(Array.from({ length: 5 }, async () => {
    for (;;) {
      const route = queue.shift();
      if (!route) return;
      const finding = await smokePage(input.baseUrl, route, input.config);
      if (finding) findings.push(finding);
    }
  }));
  return findings;
}

export async function auditProject(input: AuditInput): Promise<ExtraFinding[]> {
  const findings = [
    ...await auditSecrets(input.root),
    ...auditWrites(input.routes, input.config),
    ...await auditPages(input),
  ];
  const rank = { critical: 0, warning: 1, info: 2 };
  return [...new Map(findings.map((finding) => [finding.id, finding])).values()]
    .sort((a, b) => rank[a.severity] - rank[b.severity] || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
