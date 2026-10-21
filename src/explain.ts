import { spawn } from "node:child_process";
import { t, type Lang } from "./i18n.js";
import type { Diff, ExtraFinding } from "./types.js";

const TIMEOUT_MS = 90_000;

const LANG_NAMES: Record<Lang, string> = {
  en: "English",
  ko: "Korean",
  ja: "Japanese",
  zh: "Chinese",
  es: "Spanish",
};

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

export function buildPrompt(diff: Diff, lang: Lang = "en", extras: ExtraFinding[] = []): string {
  const exposed = diff.routes.filter((route) => route.to === "exposed");
  const errors = diff.routes.filter((route) => route.to === "error");
  const heavy = diff.pages.filter((page) => page.heavy);

  const lines = [
    "You explain the result of a pre-commit check for a Next.js app.",
    `Using only the evidence below, briefly give the likely cause and the order to check it, for each problem. Answer in ${LANG_NAMES[lang]}. Mark anything not in the evidence as a guess. Do not write code.`,
    "",
  ];

  if (exposed.length > 0) {
    lines.push("[Unlocked APIs]");
    for (const route of exposed) lines.push(`- ${route.path}: ${t(lang, route.detailKey, route.detailVars)}`);
    lines.push("");
  }
  if (errors.length > 0) {
    lines.push("[Server errors]");
    for (const route of errors) lines.push(`- ${route.path}: ${t(lang, route.detailKey, route.detailVars)}`);
    lines.push("");
  }
  if (heavy.length > 0) {
    lines.push("[Heavier pages]");
    for (const page of heavy) {
      const from = page.from === undefined ? "no baseline" : `${Math.round(page.from / 1000)}KB`;
      lines.push(`- ${page.path}: ${from} -> ${Math.round(page.to / 1000)}KB (+${Math.round(page.deltaPercent)}%)`);
    }
    lines.push("");
  }
  if (extras.length > 0) {
    lines.push("[Project checks]");
    for (const extra of extras) lines.push(`- ${t(lang, extra.messageKey, extra.messageVars)}`);
    lines.push("");
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
  options: { prefer?: string; lang?: Lang; extras?: ExtraFinding[] } = {},
): Promise<{ provider: string; text: string } | null> {
  const prompt = buildPrompt(diff, options.lang ?? "en", options.extras ?? []);
  const ordered = options.prefer
    ? [...PROVIDERS.filter((p) => p.name === options.prefer), ...PROVIDERS.filter((p) => p.name !== options.prefer)]
    : PROVIDERS;

  for (const provider of ordered) {
    const text = await runProvider(provider, prompt);
    if (text) return { provider: provider.name, text };
  }
  return null;
}
