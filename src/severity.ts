import type { Verdict, Severity } from "./types.js";

export function severityOf(verdict: Verdict): Severity {
  if (verdict === "exposed") return "critical";
  if (verdict === "check" || verdict === "error") return "warning";
  return "info";
}
