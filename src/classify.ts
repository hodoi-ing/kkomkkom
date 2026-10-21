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
  let lastClosedParenControl = false;
  const parens: boolean[] = [];

  const regexStart = (): boolean => {
    let i = out.length - 1;
    while (i >= 0 && /\s/.test(out[i])) i -= 1;
    if (i < 0) return true;
    if ("=([{,;:!&|?".includes(out[i])) return true;
    if (out[i] === ">" && out[i - 1] === "=") return true;
    if (out[i] === ")" && lastClosedParenControl) return true;
    const before = out.slice(Math.max(0, i - 8), i + 1);
    return /\b(?:return|case|typeof|instanceof|in|of|new|delete|void|yield|await|throw|else|do)$/.test(before);
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
      if (char === "/" && next !== "/" && next !== "*" && regexStart()) {
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
      if (char === "(") {
        let j = out.length - 1;
        while (j >= 0 && /\s/.test(out[j])) j -= 1;
        const end = j + 1;
        while (j >= 0 && /[A-Za-z]/.test(out[j])) j -= 1;
        const word = out.slice(j + 1, end);
        while (j >= 0 && /\s/.test(out[j])) j -= 1;
        const control = /^(?:if|while|for|with|switch|catch)$/.test(word) &&
          !/[.?#_$0-9]/.test(j >= 0 ? out[j] : "");
        parens.push(control);
        lastClosedParenControl = false;
        out += char;
        continue;
      }
      if (char === ")") {
        lastClosedParenControl = parens.pop() ?? false;
        out += char;
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
