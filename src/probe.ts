import { classify, hasAuthSignal, matchesGlob } from "./classify.js";
import type { MessageKey } from "./i18n.js";
import type { Config, Finding, RouteInfo, Verdict } from "./types.js";

const TIMEOUT_MS = 8_000;
const CONCURRENCY = 5;

function fillParams(path: string, params: Record<string, string> | undefined): string {
  return path.replace(/\[\.{0,3}([^\]]+)\]/g, (match, key: string) => params?.[key] ?? match);
}

function detailFor(verdict: Verdict): MessageKey {
  switch (verdict) {
    case "locked":
      return "detailLocked";
    case "exposed":
      return "detailExposed";
    case "check":
      return "detailCheck";
    case "error":
      return "detailError";
    default:
      return "detailUnknown";
  }
}

const LOGIN_PATH = /\/(login|log-in|signin|sign-in|signout|sign-out|auth|sso|session)(\/|$|\?)/i;

function isLoginRedirect(location: string): boolean {
  if (!location) return false;
  try {
    return LOGIN_PATH.test(new URL(location, "http://127.0.0.1").pathname);
  } catch {
    return LOGIN_PATH.test(location);
  }
}

async function probeOne(baseUrl: string, route: RouteInfo, config: Config): Promise<Finding> {
  if (config.ignoreRoutes.some((pattern) => matchesGlob(route.path, pattern))) {
    return { path: route.path, verdict: "public", detailKey: "detailIgnored" };
  }

  const params = config.sampleParams[route.path];
  if (route.dynamic && !params) {
    return { path: route.path, verdict: "unknown", detailKey: "detailDynamic" };
  }

  const url = baseUrl + fillParams(route.path, params);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { "user-agent": "kkomkkom/0.1" },
    });
  } catch {
    return { path: route.path, verdict: "unknown", detailKey: "detailTimeout" };
  }

  const redirect = res.status >= 300 && res.status < 400;
  const location = redirect ? (res.headers.get("location") ?? "") : "";
  let verdict = classify(res.status, hasAuthSignal(route.source));
  if (redirect) verdict = isLoginRedirect(location) ? "locked" : "check";

  if (verdict === "exposed" || verdict === "check") {
    const body = (await res.text().catch(() => "")).slice(0, 2048);
    if (/__next_error__|Application error|Internal Server Error/i.test(body)) {
      verdict = "error";
    } else if (body.trim() === "") {
      verdict = "check";
    }
  }

  const detailKey = redirect
    ? verdict === "locked"
      ? "detailLockedRedirect"
      : "detailRedirect"
    : detailFor(verdict);

  return {
    path: route.path,
    verdict,
    status: res.status,
    detailKey,
    detailVars: redirect
      ? { status: res.status, location: location.slice(0, 80) || "?" }
      : { status: res.status },
  };
}

export async function probeRoutes(baseUrl: string, routes: RouteInfo[], config: Config): Promise<Finding[]> {
  const queue = routes.filter((route) => route.kind === "api");
  const findings: Finding[] = [];

  const workers = Array.from({ length: CONCURRENCY }, async () => {
    for (;;) {
      const route = queue.shift();
      if (!route) return;
      findings.push(await probeOne(baseUrl, route, config));
    }
  });

  await Promise.all(workers);
  return findings.sort((a, b) => a.path.localeCompare(b.path));
}
