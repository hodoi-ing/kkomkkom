import { analyzeRoute, matchesGlob } from "./classify.js";
import { sampleTarget } from "./params.js";
import type { MessageKey } from "./i18n.js";
import type { Config, Finding, RouteInfo, Verdict } from "./types.js";

const TIMEOUT_MS = 8_000;
const CONCURRENCY = 5;
const REDIRECT_TIMEOUT_MS = 3_000;
const MAX_REDIRECT_HOPS = 3;
function safeLocation(location: string): string {
  const withoutQuery = location.split(/[?#]/, 1)[0];
  const withoutUserInfo = withoutQuery.replace(/\/\/[^/]*@/, "//");
  return withoutUserInfo.slice(0, 80) || "?";
}

async function followsToLoginPage(
  requestUrl: string,
  baseUrl: string,
  location: string,
): Promise<boolean> {
  if (!location) return false;

  let target: URL;
  try {
    target = new URL(location, requestUrl);
  } catch {
    return false;
  }

  const base = new URL(baseUrl);
  if (target.origin !== base.origin) return false;

  let url = target;
  for (let hop = 0; hop < MAX_REDIRECT_HOPS; hop += 1) {
    let res: Response;
    try {
      res = await fetch(url, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(REDIRECT_TIMEOUT_MS),
        headers: { "user-agent": "kkomkkom/0.1" },
      });
    } catch {
      return false;
    }

    if (res.status >= 300 && res.status < 400) {
      const next = res.headers.get("location");
      if (!next) return false;
      let nextUrl: URL;
      try {
        nextUrl = new URL(next, url);
      } catch {
        return false;
      }
      if (nextUrl.origin !== base.origin) return false;
      url = nextUrl;
      continue;
    }

    if (res.status === 401 || res.status === 403) return true;
    if (res.status < 200 || res.status >= 300) return false;

    const type = res.headers.get("content-type") ?? "";
    if (!type.includes("text/html")) return false;

    const body = (await res.text().catch(() => "")).slice(0, 8192).toLowerCase();
    return (
      /<input[^>]+type=["']?password/.test(body) ||
      /<form[^>]+action=["'][^"']*(login|signin|sign-in|auth)/.test(body)
    );
  }
  return false;
}

async function probeOne(baseUrl: string, route: RouteInfo, config: Config): Promise<Finding> {
  const policy = config.routePolicies?.[route.path]?.GET;
  const auth = analyzeRoute(route).methods.GET?.state ?? "unknown";
  const evidence = { method: "GET" as const, policy, auth };

  if (config.ignoreRoutes.some((pattern) => matchesGlob(route.path, pattern))) {
    return { path: route.path, verdict: "public", detailKey: "detailIgnored", ...evidence };
  }

  const sample = sampleTarget(baseUrl, route.path, config.sampleParams[route.path]);
  if ("reason" in sample) {
    return { path: route.path, verdict: "unknown", detailKey: "detailDynamic", ...evidence };
  }
  const url = sample.url;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { "user-agent": "kkomkkom/0.1" },
    });
  } catch {
    return { path: route.path, verdict: "unknown", detailKey: "detailTimeout", ...evidence };
  }

  const redirect = res.status >= 300 && res.status < 400;
  const location = redirect ? (res.headers.get("location") ?? "") : "";
  const loginRedirect = redirect ? await followsToLoginPage(url, baseUrl, location) : false;

  let verdict: Verdict;
  let detailKey: MessageKey;
  if (redirect) {
    verdict = loginRedirect ? "locked" : "check";
    detailKey = loginRedirect ? "detailLockedRedirect" : "detailRedirect";
  } else if (res.status === 401 || res.status === 403) {
    verdict = "locked";
    detailKey = "detailLocked";
  } else if (res.status >= 500) {
    verdict = "error";
    detailKey = "detailError";
  } else if (res.status === 404 || res.status === 405) {
    verdict = "unknown";
    detailKey = "detailUnknown";
  } else if (res.status >= 200 && res.status < 300) {
    const body = (await res.text().catch(() => "")).slice(0, 2048);
    if (/__next_error__|Application error|Internal Server Error/i.test(body)) {
      verdict = "error";
      detailKey = "detailError";
    } else if (policy === "protected") {
      // An explicit protected policy is checked by the response, even an empty 204.
      verdict = "exposed";
      detailKey = "detailPolicyExposed";
    } else if (policy === "public") {
      verdict = "public";
      detailKey = "detailPublic";
    } else {
      verdict = "check";
      detailKey = "detailCheck";
    }
  } else {
    verdict = "unknown";
    detailKey = "detailUnknown";
  }

  return {
    path: route.path,
    verdict,
    status: res.status,
    detailKey,
    detailVars: redirect
      ? { status: res.status, location: safeLocation(location) }
      : { status: res.status },
    ...evidence,
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
