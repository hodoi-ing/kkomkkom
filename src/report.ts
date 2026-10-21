import { t, type Lang } from "./i18n.js";
import type { Diff, RouteDiff } from "./types.js";

export interface ReportOptions {
  lang: Lang;
  color: boolean;
  buildFailed?: boolean;
  buildTail?: string;
}

const DIM = "\u001b[2m";
const BOLD = "\u001b[1m";
const RED = "\u001b[31m";
const YELLOW = "\u001b[33m";
const GREEN = "\u001b[32m";
const RESET = "\u001b[0m";

function paint(text: string, color: string, enabled: boolean): string {
  return enabled ? `${color}${text}${RESET}` : text;
}

function kb(bytes: number): string {
  if (bytes < 1000) return `${bytes}B`;
  return `${Math.round(bytes / 100) / 10}KB`;
}

export function renderReport(diff: Diff, options: ReportOptions): string {
  const { color, lang } = options;
  const lines: string[] = [];

  const exposed = diff.routes.filter((route) => route.to === "exposed");
  const newExposed = exposed.filter((route) => route.state === "new");
  const fixed = diff.routes.filter((route) => route.state === "fixed");
  const check = diff.routes.filter((route) => route.to === "check");
  const errors = diff.routes.filter((route) => route.to === "error");
  const unknown = diff.routes.filter((route) => route.to === "unknown");
  const heavy = diff.pages.filter((page) => page.heavy);

  const warnings = check.length + errors.length + heavy.length;

  const list = (items: RouteDiff[]): string[] => {
    const width = Math.max(...items.map((item) => item.path.length));
    return items.map(
      (item) => `  ${item.path.padEnd(width)}  ${t(lang, item.detailKey, item.detailVars)}`,
    );
  };

  if (options.buildFailed) {
    lines.push(paint(t(lang, "buildFailedTitle"), RED, color));
    const tail = (options.buildTail ?? "").trim().split("\n").slice(-12);
    for (const line of tail) lines.push(`  ${line}`);
    lines.push("");
  }

  lines.push(paint(t(lang, "reportTitle"), DIM, color));
  lines.push("");

  if (exposed.length > 0) {
    lines.push(paint(t(lang, "stopBanner", { count: exposed.length }), BOLD + RED, color));
    lines.push("");
  } else if (warnings > 0) {
    lines.push(paint(t(lang, "warnBanner", { count: warnings }), YELLOW, color));
    lines.push("");
  } else if (!options.buildFailed) {
    lines.push(paint(t(lang, "okBanner"), GREEN, color));
    lines.push("");
  }

  if (diff.firstRun) {
    lines.push(t(lang, "firstRunNote"));
    lines.push("");
  }

  if (exposed.length > 0) {
    const shown = newExposed.length > 0 ? newExposed : exposed;
    const title = newExposed.length > 0
      ? t(lang, "newExposedTitle", { count: newExposed.length })
      : t(lang, "exposedTitle", { count: exposed.length });
    lines.push(paint(title, RED, color));
    lines.push(...list(shown));
    lines.push("");
  }

  if (check.length > 0) {
    lines.push(paint(t(lang, "checkTitle", { count: check.length }), YELLOW, color));
    lines.push(...list(check));
    lines.push("");
  }

  if (errors.length > 0) {
    lines.push(paint(t(lang, "errorTitle", { count: errors.length }), YELLOW, color));
    lines.push(...list(errors));
    lines.push("");
  }

  if (fixed.length > 0) {
    lines.push(paint(t(lang, "fixedTitle", { count: fixed.length }), GREEN, color));
    lines.push(...list(fixed));
    lines.push("");
  }

  if (heavy.length > 0) {
    lines.push(paint(t(lang, "heavyTitle", { count: heavy.length }), YELLOW, color));
    const width = Math.max(...heavy.map((page) => page.path.length));
    for (const page of heavy) {
      const from = page.from === undefined ? "-" : kb(page.from);
      const delta = page.deltaBytes >= 0 ? `+${kb(page.deltaBytes)}` : `-${kb(-page.deltaBytes)}`;
      const percent = page.from ? `, ${page.deltaPercent >= 0 ? "+" : ""}${Math.round(page.deltaPercent)}%` : "";
      lines.push(`  ${page.path.padEnd(width)}  ${from} → ${kb(page.to)} (${delta}${percent})`);
    }
    lines.push("");
  }

  if (unknown.length > 0) {
    lines.push(paint(t(lang, "unknownTitle", { count: unknown.length }), DIM, color));
    for (const route of unknown) {
      lines.push(paint(`  ${route.path}  ${t(lang, route.detailKey, route.detailVars)}`, DIM, color));
    }
    lines.push("");
  }

  if (!diff.firstRun && exposed.length === 0 && warnings === 0) {
    const same = diff.routes.filter((route) => route.state === "same").length;
    if (same > 0) lines.push(paint(t(lang, "restSame", { count: same }), DIM, color));
  }

  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
}
