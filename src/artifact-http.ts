import { KkomkkomError } from "./errors.js";
import type { CoverageCheck, ExtraFinding } from "./types.js";

const BODY_LIMIT = 1024 * 1024;
const RESPONSE_BUDGET = 32 * BODY_LIMIT;
const CANDIDATE_LIMIT = 50;

/** Count only admitted payload bytes; EOF must be observed even at the exact limit. */
export async function readArtifactBody(
  res: Response,
  budget: { bytes: number },
  signal: AbortSignal,
): Promise<Buffer> {
  const reader = res.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    if (reader) for (;;) {
      const { done, value } = await reader.read();
      if (signal.aborted) throw new Error("http-timeout");
      if (done) break;
      if (value.byteLength > RESPONSE_BUDGET - budget.bytes) throw new Error("http-total-budget");
      if (value.byteLength > BODY_LIMIT - size) throw new Error("http-body-limit");
      budget.bytes += value.byteLength;
      size += value.byteLength;
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  } finally { await reader?.cancel().catch(() => undefined); }
}

/** Accept canonical loopback origins only; never resolve localhost through DNS. */
export function normalizeProductionUrl(value: unknown): string {
  if (typeof value !== "string") throw new KkomkkomError("errProductionUrl");
  const match = value.match(/^http:\/\/(localhost|127\.(?:\d{1,3}\.){2}\d{1,3}|\[::1\])(?::([0-9]{1,5}))?\/?$/i);
  if (!match) throw new KkomkkomError("errProductionUrl");
  let url: URL;
  try { url = new URL(value); } catch { throw new KkomkkomError("errProductionUrl"); }
  if ((match[2] !== undefined && (+match[2] < 1 || +match[2] > 65535))
    || url.hostname !== match[1].toLowerCase()) throw new KkomkkomError("errProductionUrl");
  if (url.hostname === "localhost") url.hostname = "127.0.0.1";
  return url.origin;
}

export async function inspectProductionHttp(
  origin: string,
  files: Map<string, Buffer>,
  coverage: CoverageCheck[],
): Promise<ExtraFinding[]> {
  const extras: ExtraFinding[] = [{
    id: "artifact-http:identity", severity: "info", confidence: "uncertain",
    messageKey: "artifactHttpIdentity",
  }];
  const record = (path: string | undefined, status: CoverageCheck["status"], reason: string): void => {
    coverage.push({ rule: "artifacts", path, status, reason });
  };
  record(undefined, "static-only", "http-project-identity-unverified");
  const urls = new Map<string, { file: string; bytes: Buffer }>();
  const conflicts = new Set<string>();
  for (const [file, bytes] of files) {
    const path = file.startsWith("public/") ? file.slice(7)
      : file.startsWith(".next/static/") ? `_next/static/${file.slice(13)}` : null;
    if (path === null || path.split("/").some((part) => !part || part === "." || part === ".." || part.includes("\\"))) {
      record(file, "unsupported", "http-path");
      continue;
    }
    const url = `${origin}/${path.split("/").map(encodeURIComponent).join("/")}`;
    const previous = urls.get(url);
    if (previous) {
      if (previous.bytes.equals(bytes) && !conflicts.has(url)) {
        record(file, "skipped", "http-duplicate-url");
      } else {
        conflicts.add(url);
        record(previous.file, "unsupported", "http-url-conflict");
        record(file, "unsupported", "http-url-conflict");
      }
    } else urls.set(url, { file, bytes });
  }
  const candidates = [...urls].filter(([url]) => !conflicts.has(url));
  for (const [, { file }] of candidates.slice(CANDIDATE_LIMIT)) {
    record(file, "unsupported", "http-candidate-limit");
  }
  const selected = candidates.slice(0, CANDIDATE_LIMIT);
  if (selected.length === 0) {
    record(undefined, "unsupported", "http-no-candidates");
    return extras;
  }

  const overall = new AbortController();
  const overallTimer = setTimeout(() => overall.abort("http-total-timeout"), 60000);
  let next = 0;
  const budget = { bytes: 0 };
  async function worker(): Promise<void> {
    while (next < selected.length) {
      const [url, { file, bytes: expected }] = selected[next++];
      if (overall.signal.aborted || budget.bytes >= RESPONSE_BUDGET) {
        record(file, "failed", overall.signal.aborted ? "http-total-timeout" : "http-total-budget");
        continue;
      }
      const request = new AbortController();
      const abortOverall = (): void => request.abort("http-total-timeout");
      overall.signal.addEventListener("abort", abortOverall, { once: true });
      const requestTimer = setTimeout(() => request.abort("http-timeout"), 5000);
      try {
        const res = await fetch(url, {
          method: "GET", redirect: "manual", credentials: "omit", signal: request.signal,
        });
        if (res.status < 200 || res.status >= 300) {
          await res.body?.cancel().catch(() => undefined);
          record(file, "failed", `http-status-${res.status}`);
          continue;
        }
        const body = await readArtifactBody(res, budget, request.signal);
        if (!body.equals(expected)) {
          record(file, "failed", "http-byte-mismatch");
          continue;
        }
        record(file, "checked", "http-byte-match");
        extras.push({
          id: `artifact-http:match:${file}`, file, severity: "info",
          evidenceKind: "local-production-http", confidence: "confirmed",
          messageKey: "artifactHttpMatch", messageVars: { file },
        });
      } catch (error) {
        const reason = request.signal.aborted ? request.signal.reason as string
          : error instanceof Error && ["http-total-budget", "http-body-limit"].includes(error.message)
            ? error.message : "http-request";
        record(file, "failed", reason);
      } finally {
        clearTimeout(requestTimer);
        overall.signal.removeEventListener("abort", abortOverall);
      }
    }
  }
  try {
    await Promise.all(Array.from({ length: Math.min(5, selected.length) }, () => worker()));
  } finally { clearTimeout(overallTimer); }
  return extras;
}
