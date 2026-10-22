import type { MessageKey } from "./i18n.js";

export type Verdict = "locked" | "exposed" | "check" | "public" | "unknown" | "error";
export type AuthState = "signal" | "none" | "unknown";

export type RouterKind = "app" | "pages";

export interface RouteInfo {
  path: string;
  file: string;
  kind: "api" | "page";
  dynamic: boolean;
  source: string;
  router: RouterKind;
}

export interface Finding {
  path: string;
  verdict: Verdict;
  status?: number;
  detailKey: MessageKey;
  detailVars?: Record<string, string | number>;
  method?: HttpMethod;
  policy?: RoutePolicy;
  auth?: AuthState;
}

export type MeasurementMethod = "manifest-file" | "next-output";

export interface PageWeight {
  firstLoadJs: number;
  method?: MeasurementMethod;
}

export interface Baseline {
  version: 1;
  createdAt: string;
  routes: Record<string, { verdict: Verdict }>;
  pages: Record<string, PageWeight>;
}

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export type RoutePolicy = "public" | "protected";
export type RoutePolicies = Record<string, Partial<Record<HttpMethod, RoutePolicy>>>;

export interface Config {
  ignoreRoutes: string[];
  sampleParams: Record<string, Record<string, string>>;
  port: number;
  thresholds: { jsPercent: number; jsBytes: number };
  routePolicies: RoutePolicies;
}

export type RouteState = "new" | "fixed" | "same" | "changed";

export interface RouteDiff {
  path: string;
  from?: Verdict;
  to: Verdict;
  state: RouteState;
  detailKey: MessageKey;
  detailVars?: Record<string, string | number>;
  status?: number;
  method?: HttpMethod;
  policy?: RoutePolicy;
  auth?: AuthState;
}

export interface WeightChange {
  path: string;
  from?: number;
  to: number;
  deltaBytes: number;
  deltaPercent: number;
  heavy: boolean;
  fromMethod?: MeasurementMethod;
  toMethod?: MeasurementMethod;
  comparable: boolean;
}

export interface Diff {
  firstRun: boolean;
  routes: RouteDiff[];
  pages: WeightChange[];
}

export type Severity = "critical" | "warning" | "info";

export type ExtraSeverity = "critical" | "warning" | "info";

export type CoverageState =
  | "checked"
  | "static-only"
  | "ignored"
  | "skipped"
  | "failed"
  | "unsupported";

export type CoverageRule = "api-auth" | "page-smoke" | "write-auth" | "secrets" | "build" | "server";

export interface CoverageCheck {
  rule: CoverageRule;
  path?: string;
  method?: HttpMethod;
  status: CoverageState;
  reason?: string;
}

export interface CoverageSummary {
  status: "complete" | "incomplete" | "empty";
  checks: CoverageCheck[];
  counts: Record<CoverageState, number>;
}

export interface WriteEvidence {
  method: HttpMethod;
  auth: AuthState;
  policy?: RoutePolicy;
}

export interface ExtraFinding {
  id: string;
  severity: ExtraSeverity;
  messageKey: MessageKey;
  messageVars?: Record<string, string | number>;
  evidence?: WriteEvidence[];
}
