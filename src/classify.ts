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

export function stripComments(source: string): string {
  let out = "";
  let mode: "code" | "single" | "double" | "template" | "line" | "block" = "code";

  const regexStart = (index: number): boolean => {
    let i = index - 1;
    while (i >= 0 && /\s/.test(source[i])) i -= 1;
    if (i < 0) return true;
    if ("=([{,;:!&|?".includes(source[i])) return true;
    const before = source.slice(Math.max(0, i - 8), i + 1);
    return /\b(?:return|case|typeof|instanceof|in|of|new|delete|void|yield|await)$/.test(before);
  };

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    const next = source[i + 1];

    if (mode === "code") {
      if (char === "/" && next === "/") {
        mode = "line";
        out += "  ";
        i += 1;
        continue;
      }
      if (char === "/" && next === "*") {
        mode = "block";
        out += "  ";
        i += 1;
        continue;
      }
      if (char === "/" && next !== "/" && next !== "*" && regexStart(i)) {
        out += char;
        i += 1;
        let inClass = false;
        while (i < source.length) {
          const c = source[i];
          if (c === "\\") {
            out += c + (source[i + 1] ?? "");
            i += 2;
            continue;
          }
          out += c;
          if (c === "[") inClass = true;
          else if (c === "]") inClass = false;
          else if (c === "/" && !inClass) break;
          i += 1;
        }
        continue;
      }
      if (char === "'") mode = "single";
      else if (char === '"') mode = "double";
      else if (char === "`") mode = "template";
      out += char;
      continue;
    }

    if (mode === "line") {
      if (char === "\n") {
        mode = "code";
        out += char;
      } else {
        out += " ";
      }
      continue;
    }

    if (mode === "block") {
      if (char === "*" && next === "/") {
        mode = "code";
        out += "  ";
        i += 1;
        continue;
      }
      out += char === "\n" ? "\n" : " ";
      continue;
    }

    out += char;
    if (char === "\\") {
      if (i + 1 < source.length) out += source[i + 1];
      i += 1;
      continue;
    }
    if (
      (mode === "single" && char === "'") ||
      (mode === "double" && char === '"') ||
      (mode === "template" && char === "`")
    ) {
      mode = "code";
    }
  }

  return out;
}

export function hasAuthSignal(source: string): boolean {
  const code = stripComments(source);
  return AUTH_SIGNALS.some((signal) => signal.test(code));
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
