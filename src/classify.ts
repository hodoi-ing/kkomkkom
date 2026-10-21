import type { Verdict } from "./types.js";

const AUTH_SIGNALS = [
  /\bauth\s*\(/,
  /getServerSession/,
  /getToken\s*\(/,
  /verifyToken/,
  /requireUser/,
  /currentUser/,
  /cookies\s*\(/,
  /headers\s*\(\s*\)\s*\.get\s*\(\s*["']authorization/i,
];

export function hasAuthSignal(source: string): boolean {
  return AUTH_SIGNALS.some((signal) => signal.test(source));
}

export function classify(status: number, hasSignal: boolean): Verdict {
  if (status === 401 || status === 403) return "locked";
  if (status >= 300 && status < 400) return "check";
  if (status >= 500) return "error";
  if (status === 404 || status === 405) return "unknown";
  if (status >= 200 && status < 300) return hasSignal ? "exposed" : "check";
  return "unknown";
}

export function matchesGlob(path: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(path);
}
