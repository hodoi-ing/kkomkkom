import { spawn } from "node:child_process";
import type { Diff } from "./types.js";

const TIMEOUT_MS = 90_000;

export interface Provider {
  name: string;
  command: string;
  args: (prompt: string) => string[];
}

export const PROVIDERS: Provider[] = [
  { name: "claude", command: "claude", args: (prompt) => ["-p", prompt] },
  { name: "codex", command: "codex", args: (prompt) => ["exec", prompt] },
  { name: "gemini", command: "gemini", args: (prompt) => ["-p", prompt] },
];

export function buildPrompt(diff: Diff): string {
  const exposed = diff.routes.filter((route) => route.to === "exposed");
  const errors = diff.routes.filter((route) => route.to === "error");
  const heavy = diff.pages.filter((page) => page.heavy);

  const lines = [
    "너는 Next.js 앱의 커밋 전 점검 결과를 설명하는 도우미다.",
    "아래 증거만 보고, 각 문제의 가능한 원인과 확인 순서를 한국어로 짧게 알려줘.",
    "증거에 없는 내용은 추측이라고 표시해. 코드는 쓰지 마.",
    "",
  ];

  if (exposed.length > 0) {
    lines.push("[안 잠긴 API]");
    for (const route of exposed) lines.push(`- ${route.path}: ${route.detail}`);
    lines.push("");
  }
  if (errors.length > 0) {
    lines.push("[서버 오류]");
    for (const route of errors) lines.push(`- ${route.path}: ${route.detail}`);
    lines.push("");
  }
  if (heavy.length > 0) {
    lines.push("[무거워진 페이지]");
    for (const page of heavy) {
      const from = page.from === undefined ? "기준 없음" : `${Math.round(page.from / 1000)}KB`;
      lines.push(`- ${page.path}: ${from} → ${Math.round(page.to / 1000)}KB (${Math.round(page.deltaPercent)}% 증가)`);
    }
  }

  return lines.join("\n").trim();
}

function runProvider(provider: Provider, prompt: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(provider.command, provider.args(prompt), {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let out = "";
    let err = "";
    child.stdout?.on("data", (chunk) => (out += chunk));
    child.stderr?.on("data", (chunk) => (err += chunk));

    const timer = setTimeout(() => child.kill("SIGTERM"), TIMEOUT_MS);

    child.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return resolve(null);
      const text = out.trim() || err.trim();
      resolve(text.length > 0 ? text : null);
    });
  });
}

export async function explain(
  diff: Diff,
  options: { prefer?: string } = {},
): Promise<{ provider: string; text: string } | null> {
  const prompt = buildPrompt(diff);
  const ordered = options.prefer
    ? [...PROVIDERS.filter((p) => p.name === options.prefer), ...PROVIDERS.filter((p) => p.name !== options.prefer)]
    : PROVIDERS;

  for (const provider of ordered) {
    const text = await runProvider(provider, prompt);
    if (text) return { provider: provider.name, text };
  }
  return null;
}
