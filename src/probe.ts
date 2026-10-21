import { classify, hasAuthSignal, matchesGlob } from "./classify.js";
import type { Config, Finding, RouteInfo, Verdict } from "./types.js";

const TIMEOUT_MS = 8_000;
const CONCURRENCY = 5;

function fillParams(path: string, params: Record<string, string> | undefined): string {
  return path.replace(/\[\.{0,3}([^\]]+)\]/g, (match, key: string) => params?.[key] ?? match);
}

function detailFor(verdict: Verdict, status: number): string {
  switch (verdict) {
    case "locked":
      return status >= 300 && status < 400
        ? `로그인 페이지로 넘어갑니다 (${status})`
        : `로그인 없이는 막힙니다 (${status})`;
    case "exposed":
      return `로그인 없이 데이터가 그대로 나옵니다 (${status})`;
    case "check":
      return `인증 코드가 없습니다. 일부러 공개한 API인지 확인하세요 (${status})`;
    case "error":
      return `서버 오류가 납니다 (${status})`;
    default:
      return `확인하지 못했습니다 (${status})`;
  }
}

async function probeOne(baseUrl: string, route: RouteInfo, config: Config): Promise<Finding> {
  if (config.ignoreRoutes.some((pattern) => matchesGlob(route.path, pattern))) {
    return { path: route.path, verdict: "public", detail: "공개 목록에 있어 건너뜁니다" };
  }

  const params = config.sampleParams[route.path];
  if (route.dynamic && !params) {
    return {
      path: route.path,
      verdict: "unknown",
      detail: "동적 라우트입니다. kkomkkom.config.json의 sampleParams에 값을 넣으면 검사합니다",
    };
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
    return { path: route.path, verdict: "unknown", status: undefined, detail: "응답이 없습니다 (타임아웃 또는 연결 실패)" };
  }

  let verdict = classify(res.status, hasAuthSignal(route.source));

  if (verdict === "exposed" || verdict === "check") {
    const body = (await res.text().catch(() => "")).slice(0, 2048);
    if (/__next_error__|Application error|Internal Server Error/i.test(body)) {
      verdict = "error";
    } else if (body.trim() === "") {
      verdict = "check";
    }
  }

  return { path: route.path, verdict, status: res.status, detail: detailFor(verdict, res.status) };
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
