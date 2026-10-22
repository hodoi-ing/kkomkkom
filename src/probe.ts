import { analyzeRoute, matchesGlob } from "./classify.js";
import { readBody } from "./http.js";
import { sampleTarget } from "./params.js";
import type { MessageKey } from "./i18n.js";
import type { Config, CoverageCheck, Finding, RouteInfo, Verdict } from "./types.js";

const TIMEOUT_MS = 8_000;
const CONCURRENCY = 5;
const REDIRECT_TIMEOUT_MS = 3_000;
const MAX_REDIRECT_HOPS = 3;
const LOGIN_BODY_LIMIT = 8192;
const ERROR_BODY_LIMIT = 2048;

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
      await res.body?.cancel().catch(() => {});
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

    if (res.status === 401 || res.status === 403) {
      await res.body?.cancel().catch(() => {});
      return true;
    }
    if (res.status < 200 || res.status >= 300) {
      await res.body?.cancel().catch(() => {});
      return false;
    }

    const type = res.headers.get("content-type") ?? "";
    if (!type.includes("text/html")) {
      await res.body?.cancel().catch(() => {});
      return false;
    }

    let body: string;
    try {
      body = (await readBody(res, LOGIN_BODY_LIMIT)).text.toLowerCase();
    } catch {
      // An incomplete login page cannot prove the redirect lands on a login form.
      return false;
    }
    return (
      /<input[^>]+type=["']?password/.test(body) ||
      /<form[^>]+action=["'][^"']*(login|signin|sign-in|auth)/.test(body)
    );
  }
  return false;
}

async function probeOne(
  baseUrl: string,
  route: RouteInfo,
  config: Config,
  coverage?: CoverageCheck[],
): Promise<Finding> {
  const policy = config.routePolicies?.[route.path]?.GET;
  const auth = analyzeRoute(route).methods.GET?.state ?? "unknown";
  const evidence = { method: "GET" as const, policy, auth };
  const check = (status: CoverageCheck["status"], reason: string) => {
    coverage?.push({ rule: "api-auth", path: route.path, method: "GET", status, reason });
  };

  if (config.ignoreRoutes.some((pattern) => matchesGlob(route.path, pattern))) {
    check("ignored", "ignoreRoutes");
    return { path: route.path, verdict: "public", detailKey: "detailIgnored", ...evidence };
  }

  const sample = sampleTarget(baseUrl, route.path, config.sampleParams[route.path]);
  if ("reason" in sample) {
    check(sample.reason === "missing" ? "failed" : "unsupported", `sample-${sample.reason}`);
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
    check("failed", "timeout");
    return { path: route.path, verdict: "unknown", detailKey: "detailTimeout", ...evidence };
  }

  const redirect = res.status >= 300 && res.status < 400;
  const location = redirect ? (res.headers.get("location") ?? "") : "";
  const success = res.status >= 200 && res.status < 300;

  if (!success) {
    // Nothing below reads these bodies; release the connection deliberately.
    if (redirect) await res.body?.cancel().catch(() => {});
  }
  const loginRedirect = redirect ? await followsToLoginPage(url, baseUrl, location) : false;

  if (res.status === 404) {
    check("failed", "not-found");
    await res.body?.cancel().catch(() => {});
  } else if (res.status === 405) {
    // A statically GET-less route cannot serve GET: the 405 confirms the
    // selected scope instead of hiding a required check.
    const getHandler = analyzeRoute(route).methods.GET !== undefined;
    check(getHandler ? "failed" : "checked", "method-not-allowed");
    await res.body?.cancel().catch(() => {});
  } else if (success) {
    // Read the body before deciding: a cut-off transfer is not a success.
    try {
      const read = await readBody(res, ERROR_BODY_LIMIT);
      const body = read.text;
      check("checked", read.truncated ? "response-limited" : "response");
      if (/__next_error__|Application error|Internal Server Error/i.test(body)) {
        return {
          path: route.path, verdict: "error", status: res.status, detailKey: "detailError",
          detailVars: { status: res.status }, ...evidence,
        };
      }
    } catch {
      check("failed", "body-read");
      return {
        path: route.path, verdict: "unknown", status: res.status, detailKey: "detailBodyFailed",
        detailVars: { status: res.status }, ...evidence,
      };
    }
  } else if (res.status === 401 || res.status === 403 || res.status >= 500 || redirect) {
    check("checked", "response");
    await res.body?.cancel().catch(() => {});
  } else {
    // A 400/408/429-style response does not confirm the GET check.
    check("failed", `http-${res.status}`);
    await res.body?.cancel().catch(() => {});
  }

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
  } else if (success) {
    if (policy === "protected") {
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

export async function probeRoutes(
  baseUrl: string,
  routes: RouteInfo[],
  config: Config,
  coverage?: CoverageCheck[],
): Promise<Finding[]> {
  const queue = routes.filter((route) => route.kind === "api");
  const findings: Finding[] = [];

  const workers = Array.from({ length: CONCURRENCY }, async () => {
    for (;;) {
      const route = queue.shift();
      if (!route) return;
      findings.push(await probeOne(baseUrl, route, config, coverage));
    }
  });

  await Promise.all(workers);
  return findings.sort((a, b) => a.path.localeCompare(b.path));
}
