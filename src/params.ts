// Shared dynamic-parameter filling for API probes and page smoke checks.
const DYNAMIC = /\[\[\.\.\.([^\]]+)\]\]|\[\.\.\.([^\]]+)\]|\[([^\]]+)\]/g;

export type SampleTarget =
  | { url: string }
  | { reason: "missing" | "unsupported" };

function encodeSegment(value: string): string | null {
  // "." and ".." are removed by WHATWG URL normalization even when their dots
  // are percent-encoded, so they must never become a probe target.
  if (value === "." || value === "..") return null;
  try {
    return encodeURIComponent(value).replace(/\./g, "%2E");
  } catch {
    return null;
  }
}

function fillPath(
  path: string,
  params: Record<string, string> | undefined,
): { path: string } | { reason: "missing" | "unsupported" } {
  let failure: "missing" | "unsupported" | null = null;
  const filled = path.replace(DYNAMIC, (_match, optional: string, catchAll: string, single: string) => {
    if (optional !== undefined || catchAll !== undefined) {
      failure ??= "unsupported";
      return "";
    }
    const value = params?.[single];
    if (value === undefined) {
      failure ??= "missing";
      return "";
    }
    const encoded = encodeSegment(value);
    if (encoded === null) {
      failure ??= "unsupported";
      return "";
    }
    return encoded;
  });
  if (failure) return { reason: failure };
  // A malformed template would leave brackets in the request path.
  if (filled.includes("[") || filled.includes("]")) return { reason: "unsupported" };
  if (!filled.startsWith("/") || filled.includes("?") || filled.includes("#")) {
    return { reason: "unsupported" };
  }
  return { path: filled };
}

export function fillParams(
  path: string,
  params: Record<string, string> | undefined,
): string | null {
  const result = fillPath(path, params);
  return "path" in result ? result.path : null;
}

export function sampleTarget(
  baseUrl: string,
  path: string,
  params: Record<string, string> | undefined,
): SampleTarget {
  const filled = fillPath(path, params);
  if ("reason" in filled) return filled;
  try {
    const base = new URL(baseUrl);
    const url = new URL(filled.path, base);
    if (url.origin !== base.origin || url.search !== "" || url.hash !== "") {
      return { reason: "unsupported" };
    }
    return { url: url.href };
  } catch {
    return { reason: "unsupported" };
  }
}
