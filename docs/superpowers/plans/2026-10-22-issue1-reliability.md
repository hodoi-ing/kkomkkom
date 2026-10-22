# Issue #1 reliability implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking. Implementation belongs to Herdr tab `2`; the coordinator independently reviews each batch.

**Goal:** Fix the reproduced correctness and reliability failures in issue #1 before adding issue #2 features.

**Architecture:** Preserve the existing engine and attach explicit access policy, per-method evidence and per-check coverage. All output surfaces consume the same engine result; filesystem/process failures must not become successful empty measurements.

**Tech Stack:** Node >=20, TypeScript, node:test, local Next fixture. Runtime TypeScript parsing must be declared as a production dependency, not depend on dev installation.

**Spec:** `docs/superpowers/specs/2026-10-22-issue1-reliability-design.md`

## Global Constraints

- GET-only, no cookies or Authorization; do not send write requests.
- Preserve user changes. No publishing or visibility changes. Coordinator handles reviewed remote integration.
- No TTFB, GUI, daemon, new platform support or agent-specific installation tests.
- Keep 5 report languages; report actual evidence and limits rather than deployment safety.
- 0=nonblocking within scope; 1=findings/strict violation; 2=config/environment/tool error.
- Existing completed checks are trusted; run relevant new regressions and final changed-system integration.

## Review Focus

- A sample parameter containing `?`, `#`, `/`, or `..` must not probe another route/origin: cover in Task 2.
- A nested function declaration is not executed auth and another method's guard is not shared: cover in Task 2.
- Null/array MCP frames and error paths must not crash the stream or expose input secrets: cover in Tasks 1/5.
- Partial body reads, child startup failures and cleanup must be bounded and preserve unrelated servers: cover in Tasks 1/3.
- A missing chunk, invalid baseline, or concurrent update must not replace valid state with zeros/partial files: cover in Task 4.

---

### Task 1: Local process safety and validated boundaries

**Files:** `src/server.ts`, `src/build.ts`, `src/config.ts`, `src/mcp.ts`, `src/errors.ts`, `src/i18n.ts`, related tests; small shared helper only where process handling is genuinely shared.

**Interfaces:** retain `startDevServer(root, port, options): Promise<DevServer>` and `loadConfig(root): Promise<Config>`; add validated routePolicies to Config. Preserve DevServer ownership/stop contract.

- [ ] Add failing node:test regressions for localhost spawn args, missing runner, immediate exit, timeout/interrupt cleanup, reuse ownership; reject bad config port/shape and malformed MCP args without crashing subsequent requests.
- [ ] Run focused regressions and record failing cases, not a rerun of historical completed checks.
- [ ] Resolve installed Next directly with Node; handle error/exit/close, cancellation and bounded process cleanup. Validate configuration/MCP boundaries with field-specific sanitized errors.
- [ ] Run focused tests (`npm run build && node --test test/server.test.js test/config.test.js test/mcp.test.js`) and commit only Task 1 changes.

### Task 2: Explicit access policy and per-method AST analysis

**Files:** `src/types.ts`, `src/classify.ts`, `src/probe.ts`, `src/audit.ts`, `src/config.ts`, `package.json`, lockfile; `test/classify.test.js`, `test/probe.test.js`, `test/audit.test.js`, config/analysis tests.

**Interfaces:** Config.routePolicies is an exact route-template → method → public/protected mapping. Preserve probeRoutes' sorted findings and attach method/policy/static-analysis evidence. Keep hasAuthSignal as compatibility helper if needed but never use it as proof of protected policy.

- [ ] Add failing tests for string/regex/template fake calls, public session 200, protected/no-auth 200 and empty 204; GET-auth/POST-no-auth and inverse; alias exports, wrappers/reexports, pages/api branches and uncalled nested functions. Assert no write HTTP request occurs and unsafe sample text cannot alter routing.
- [ ] Run focused tests to show each new regression failing.
- [ ] Implement bounded AST method analysis and route policy resolution. Move runtime parser dependency into production dependencies. Preserve locked/redirect behavior, unknown for unsupported indirect analysis; never share another handler's auth.
- [ ] Run relevant tests and record parser install cost; commit.

### Task 3: Unified coverage, output schema and strict behavior

**Files:** `src/types.ts`, `src/run.ts`, `src/audit.ts`, `src/probe.ts`, `src/report.ts`, `src/cli.ts`, `src/mcp.ts`, `src/i18n.ts`, `src/explain.ts`, report/run/MCP tests.

**Interfaces:** RunResult carries schemaVersion=2, per-check coverage and aggregate complete/incomplete/empty. CLI JSON retains existing diff/extra fields and exposes the common result; MCP returns equivalent structured data plus text. Coverage states/reasons follow the spec.

- [ ] Add failing tests for dynamic sample missing, partial timeout, all ignored, POST-only, fast build skipped, zero effective checks, reused server identity, body byte/time limits. Pin ordinary/strict exit codes and non-success banners.
- [ ] Implement coverage from actual check outcomes (including successful and skipped pages), not inference from warnings alone. Keep build failure and execution-error distinction.
- [ ] Update report/explanation/CLI/MCP and all five languages; no global safety claim. Bound HTTP body reads and cancel discarded bodies.
- [ ] Run report/run/MCP/CLI regressions and commit.

### Task 4: Trustworthy measurements and explicit atomic baseline writes

**Files:** `src/build.ts`, `src/baseline.ts`, `src/run.ts`, `src/types.ts`, errors/i18n, build/baseline/run tests.

**Interfaces:** PageWeight retains firstLoadJs for known measurements with method metadata; missing measurements are explicit coverage, not 0. Baseline loader validates schema and preserves invalid bytes. General checks never save; --update is the only create/update operation.

- [ ] Add failing tests for decimal/case-insensitive MB, missing/unreadable chunk, real zero, duplicates, different measurement methods and legacy baselines; repeated checks preserve byte-identical baseline; incomplete update refuses; concurrent save leaves valid JSON without lock/temp leaks.
- [ ] Run failing tests. Implement measurement errors, compatible comparisons, config/baseline value validation, atomic unique temporary-file+rename under exclusive lock.
- [ ] Preserve existing weights in fast updates; reject updates with failures/incompleteness. Never migrate a corrupt baseline implicitly.
- [ ] Run build/baseline/run tests and commit.

### Task 5: Consumer, production-build and interface integration

**Files:** `scripts/verify.mjs`, fixture files as needed, `test/mcp.test.js`, `README.md`, `docs/verification-2026-10-22.md`, `TASKLIST.md`; update demo output if changed.

- [ ] Add actual production Next build/manifest flow (not only --fast) and MCP tools/call normal/config/project errors. Pack to an isolated consumer and run CLI/MCP using production dependencies only; assert no source mutation during default checks.
- [ ] Run `npm test`, `npm run verify`, production integration and isolated pack-consumer checks. Record exact commands, outcomes, environment and limitations; never substitute test counts for evidence.
- [ ] Align README baseline/schema/port/local MCP examples and policy/coverage semantics. Preserve private/unpublished status and state untested platforms honestly.
- [ ] Present defect → files → before/after → regression evidence summary to coordinator. Coordinator independently checks the diff, relevant edge cases and integration output, requests fixes, then commits/pushes reviewed main and synchronizes local HEAD.

## Follow-on

Issue #2 uses a separate small design/plan after #1 review. Its deferred client tests and expansion candidates remain deferred. Protection application must remain a separate explicit user operation of the product; development authorization does not authorize changing unrelated projects.
