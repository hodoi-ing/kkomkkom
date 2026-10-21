import type { MessageKey } from "./i18n.js";

export type Verdict = "locked" | "exposed" | "check" | "public" | "unknown" | "error";

export interface RouteInfo {
  path: string;
  file: string;
  kind: "api" | "page";
  dynamic: boolean;
  source: string;
}

export interface Finding {
  path: string;
  verdict: Verdict;
  status?: number;
  detailKey: MessageKey;
  detailVars?: Record<string, string | number>;
}

export interface PageWeight {
  firstLoadJs: number;
}

export interface Baseline {
  version: 1;
  createdAt: string;
  routes: Record<string, { verdict: Verdict }>;
  pages: Record<string, PageWeight>;
}

export interface Config {
  ignoreRoutes: string[];
  sampleParams: Record<string, Record<string, string>>;
  port: number;
  thresholds: { jsPercent: number; jsBytes: number };
}

export type RouteState = "new" | "fixed" | "same" | "changed";

export interface RouteDiff {
  path: string;
  from?: Verdict;
  to: Verdict;
  state: RouteState;
  detailKey: MessageKey;
  detailVars?: Record<string, string | number>;
}

export interface WeightChange {
  path: string;
  from?: number;
  to: number;
  deltaBytes: number;
  deltaPercent: number;
  heavy: boolean;
}

export interface Diff {
  firstRun: boolean;
  routes: RouteDiff[];
  pages: WeightChange[];
}

export type Severity = "critical" | "warning" | "info";

export type ExtraSeverity = "critical" | "warning" | "info";

export interface ExtraFinding {
  id: string;
  severity: ExtraSeverity;
  messageKey: MessageKey;
  messageVars?: Record<string, string | number>;
}
