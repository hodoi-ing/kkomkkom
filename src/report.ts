import type { Diff, RouteDiff } from "./types.js";

export interface ReportOptions {
  color: boolean;
  buildFailed?: boolean;
  buildTail?: string;
}

const DIM = "\u001b[2m";
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

function list(items: RouteDiff[]): string[] {
  const width = Math.max(...items.map((item) => item.path.length));
  return items.map((item) => `  ${item.path.padEnd(width)}  ${item.detail}`);
}

export function renderReport(diff: Diff, options: ReportOptions): string {
  const { color } = options;
  const lines: string[] = [];
  const exposed = diff.routes.filter((route) => route.to === "exposed");
  const newExposed = exposed.filter((route) => route.state === "new");
  const fixed = diff.routes.filter((route) => route.state === "fixed");
  const check = diff.routes.filter((route) => route.to === "check" && route.state !== "same");
  const errors = diff.routes.filter((route) => route.to === "error");
  const unknown = diff.routes.filter((route) => route.to === "unknown");
  const heavy = diff.pages.filter((page) => page.heavy);

  if (options.buildFailed) {
    lines.push(paint("🏗️  빌드가 실패했습니다", RED, color));
    const tail = (options.buildTail ?? "").trim().split("\n").slice(-12);
    for (const line of tail) lines.push(`  ${line}`);
    lines.push("");
  }

  lines.push(paint("꼼꼼 — 커밋 전 점검", DIM, color));
  lines.push("");

  if (diff.firstRun) {
    lines.push("첫 실행이라 전체를 보여줍니다. 이 상태를 기준으로 저장합니다.");
    lines.push("");
  }

  if (exposed.length > 0) {
    const title = newExposed.length > 0 ? `🔴 새로 뚫린 문 ${newExposed.length}개` : `🔴 뚫린 문 ${exposed.length}개`;
    lines.push(paint(title, RED, color));
    lines.push(...list(newExposed.length > 0 ? newExposed : exposed));
    lines.push("");
  }

  if (check.length > 0) {
    lines.push(paint(`🟡 확인이 필요한 문 ${check.length}개`, YELLOW, color));
    lines.push(...list(check));
    lines.push("");
  }

  if (errors.length > 0) {
    lines.push(paint(`⚠️  서버 오류가 나는 문 ${errors.length}개`, YELLOW, color));
    lines.push(...list(errors));
    lines.push("");
  }

  if (fixed.length > 0) {
    lines.push(paint(`🟢 막힌 문 ${fixed.length}개`, GREEN, color));
    lines.push(...list(fixed));
    lines.push("");
  }

  if (heavy.length > 0) {
    lines.push(paint(`🐢 무거워진 페이지 ${heavy.length}개`, YELLOW, color));
    const width = Math.max(...heavy.map((page) => page.path.length));
    for (const page of heavy) {
      const from = page.from === undefined ? "기준 없음" : kb(page.from);
      const delta = page.deltaBytes >= 0 ? `+${kb(page.deltaBytes)}` : `-${kb(-page.deltaBytes)}`;
      const percent = page.from ? `, ${page.deltaPercent >= 0 ? "+" : ""}${Math.round(page.deltaPercent)}%` : "";
      lines.push(`  ${page.path.padEnd(width)}  ${from} → ${kb(page.to)} (${delta}${percent})`);
    }
    lines.push("");
  }

  if (unknown.length > 0) {
    lines.push(paint(`⚪ 확인하지 못한 문 ${unknown.length}개`, DIM, color));
    for (const route of unknown) lines.push(paint(`  ${route.path}  ${route.detail}`, DIM, color));
    lines.push("");
  }

  if (!diff.firstRun) {
    if (exposed.length === 0 && heavy.length === 0 && errors.length === 0) {
      lines.push(paint("✅ 지난번과 달라진 문제가 없습니다.", GREEN, color));
    } else {
      const same = diff.routes.filter((route) => route.state === "same").length;
      lines.push(paint(`   나머지 ${same}개는 지난번과 같습니다.`, DIM, color));
    }
  }

  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
}

