# Issue #2 artifact inspection and limited protection implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans task-by-task. Herdr tab `2` implements; the coordinator reviews between tasks. Do not begin implementation before issue #1 review passes.

**Goal:** Add lightweight, opt-in Next production artifact inspection, verified local exposure checks and one reversible configuration protection operation.

**Architecture:** Reuse issue #1's shared results, masking, coverage and exit policy. Static artifact mode neither builds nor starts a server by default. Protection is a separate explicit CLI flow, never part of ordinary CLI/CI/MCP inspection.

**Tech Stack:** Node >=20, existing TypeScript parser, node:test, local Next production fixture. No additional production package is expected.

**Spec:** `docs/superpowers/specs/2026-10-22-issue2-artifact-protection-design.md`

## Global Constraints

- Private/unpublished repository and package remain private/unpublished; coordinator integrates reviewed commits remotely.
- GET-only, no cookies/Authorization, opt-in HTTP is loopback only and never follows redirects externally.
- Basic inspection does not modify user source/config/dependencies, install tools, run AI, build or start servers implicitly.
- File limit 1 MiB, total read budget 32 MiB, file count limit 2000; budget skips/read failures are visible coverage.
- Default Next output only initially; unknown config/output is unsupported, never a clean success.
- Preserve schema version, stable rule IDs, 5 languages and 0/1/2 exit policy from issue #1.
- No agent-client installation tests, obfuscator/Electron/mobile implementation or new GUI/daemon/cloud service.

## Review Focus

- Symlinked files/directories and encoded HTTP paths cannot read/probe outside the chosen project/origin: Task 2/3.
- A source map in server-only/upload-only storage is not public exposure: Task 2.
- A 200 SPA fallback or redirect is not proof that a named sensitive file was served: Task 3.
- Public/example keys are not real secrets, while fake sensitive values must remain absent from every output: Task 2/3.
- Dirty/raced config and post-apply edits must never be overwritten by apply or restore: Task 4.

---

### Task 1: Measured baseline and support contract

**Files:** `docs/measurements-2026-10-22.md`, minimal measurement script only if needed for repeatability, `TASKLIST.md`.

**Interfaces:** record package compressed/unpacked bytes, production dependency disk/download observation, separate static/HTTP/full-build wall time and max RSS with Node/OS/fixture/cache/commands. Missing measurements stay explicitly unmeasured.

- [ ] Preserve pre-parser pack observation: commit f9a21ff, current generated dist; `npm pack --dry-run --ignore-scripts --json` produced compressed 38691 B, unpacked 120918 B, 41 entries, zero declared runtime dependencies. This is a dry-run package-size observation, not install/download/RSS measurement or original release baseline. npm output here is keyed object, not always array; scripts must handle both shapes.
- [ ] Measure reviewed issue #1 package/production dependency install and fixed fixture costs, with commands/results saved. No hidden network downloads in checks; record npm installation network separately.
- [ ] Record supported/unsupported output and tested OS boundaries. Coordinator reviews actual observations, not estimated KB→MB conversions; commit.

### Task 2: Shared artifact rules with standalone static CLI/MCP mode

**Files:** create `src/artifacts.ts` (discovery and rules, split only if responsibility demands), artifact tests/fixtures; modify config/types/run/cli/mcp/report/i18n/explain/README and shared secret helpers as required.

**Interfaces:** `--artifacts` selects a standalone static production-artifact inspection; MCP `artifacts: true` selects the same engine path. Existing --fast semantics do not change. `--fresh` / MCP `fresh: true` requires artifacts mode and explicitly builds first. Config `artifactExceptions: Array<{ruleId:string,file:string,reason:string}>` suppresses only exact known rule/file findings with a nonempty reason; suppression remains visible in coverage.

Rule IDs: `artifact-source-map`, `artifact-sensitive-file`, `artifact-client-secret`, `artifact-server-boundary`. Rule IDs are stable; occurrence IDs can include file/line. Evidence distinguishes `configuration`, `artifact`, `source-import`, `local-production-http`; confidence is `confirmed` for the observation, not a blanket vulnerability assertion.

- [x] Write failing tests for maps absent/present/inline/reference/private-server/upload storage; config/artifact mismatch; public sensitive files versus repository-only tests; real fake secret/public key/example placeholders; missing/stale/unsupported output; null/wrong exceptions; oversized files, read failures and symlink escape.
- [x] Implement bounded discovery of public and .next/static plus nonexecuting Next config support detection. Missing or unsupported artifacts yield visible coverage, not all-clear. Distinguish server-only evidence.
- [x] Reuse secret detection/masking; add limited use-client local static-import tracing with server-only evidence. Unknown alias/dynamic imports produce unsupported coverage, not safe/unsafe guesses. Deduplicate same rule/file/location.
- [x] Integrate CLI/MCP JSON/text and all 5 languages from the shared engine. Run tests that assert no build/server/AI/installation occurs in static mode and no source/config/dependency writes. Commit for coordinator review. Coordinator PASS recorded in TASKLIST and Task2.1 verification report.

### Task 2.1: Close the observed client-information gaps before HTTP

Coordinator reproduction on `e5e6aa3`: a plain `PRIVATE_TOKEN` value from root `.env` embedded verbatim in a client bundle, and a use-client → local module → `@prisma/client` runtime import without a `server-only` marker both returned zero findings and complete coverage. These are issue #2 section C requirements, not additional platforms or protection tools.

**Files:** artifact engine, shared env parsing as needed, artifact tests, five-language messages and README support boundaries.

- [x] Pin a failing fixture for a non-placeholder sensitive server env value found in a client artifact; report the key/location, never its value. Distinguish this known-value observation (warning/uncertainty where privacy intent is not proven) from provider-key pattern criticals and mere name signals. Public `NEXT_PUBLIC_*` values and ordinary version/URL/example values must not be classified as private solely because they occur in an env file.
- [x] Pin AST runtime import evidence for a small documented set of server-specific modules: `pg`, `mysql2`, `@prisma/client`, `firebase-admin`, filesystem/process/network Node modules, `@clerk/nextjs/server`, and the `getServerSession` import from `next-auth`. Keep React/client auth and type-only imports clean. This is potential server-boundary misuse evidence, not proof of a deployed leak. Unknown indirect env keys remain unverified.
- [x] Account for the separately validated inspection JSON config in the advertised total/count budget. The smallest safe option is to reserve the loader's maximum 1 MiB and one entry from the 32 MiB/2000 allowance, reuse the actual exported config limit, and document the reservation; no new loader abstraction is necessary.
- [x] Run the new targeted regressions, preserve existing masking/readonly contracts, then request coordinator review. Do not repeat completed issue #1 checks. Coordinator directly passed six positive cases and nine masking regressions; see `docs/verification-2026-10-22-task21.md`.

### Task 3: Explicit loopback production HTTP and integration costs

**Files:** artifacts/probe HTTP helper as appropriate; CLI/MCP arg validation; artifact/MCP/integration tests; verify script; measurements and support documentation.

**Interfaces:** CLI `--production-url http://127.0.0.1:PORT`, MCP `productionUrl` is allowed only with artifacts mode. Restrict hostname to numeric loopback/localhost, forbid credentials/query/fragment/non-http schemes, do not follow redirects. Report server/project identity uncertainty. Match bounded served content against the artifact to establish specific-file exposure.

**Concrete safety contract:**
- Normalize accepted `localhost` to a numeric loopback before fetch; never rely on arbitrary DNS or suffix matching. Encode each relative artifact path segment, and never send cookies, Authorization, raw source/env contents or a write request.
- Only files inside verified `public/` or `.next/static/` boundaries are HTTP candidates. Deduplicate by URL; do not request source graph files, `external-target` or `outside-boundary` references.
- Confirm a file only on a complete 2xx body with an exact raw-byte content match. Redirects, SPA fallbacks, truncated/failed bodies and mismatched bytes remain unconfirmed. Do not expose file contents or secret-bearing digests in any result/log/explanation.
- Preserve static observations even when HTTP returns 404; label actual local serving evidence separately from Internet deployment or project identity. An explicit HTTP selection with no eligible targets must say it performed no file verification, not claim the server was verified.
- Bound requests to 50 unique candidates, 5 concurrent, 5 seconds per request and 60 seconds overall. Bound response bodies to 1 MiB each and 32 MiB aggregate HTTP payload; this is a separate response budget from the documented local-file scan reservation. Limits and remaining unverified targets are visible coverage, never silent success.
- Runtime argument validation, normal/error MCP tools/call, exact-boundary body sizes, binary byte mismatches, empty/missing outputs and all five language messages are part of this task's regressions.

- [x] Add failing tests for localhost exposure, SPA 200 fallback, redirect, mismatched served content, nonloopback/IP tricks/userinfo, body timeout and budget; prove write requests and auth headers never occur.
- [x] Add opt-in local HTTP evidence without starting/reconfiguring unrelated servers. Reuse body limits/cancellation; observation limits remain visible.
- [x] Run real Next production build → static inspection → explicit local production HTTP; isolated packed consumer CLI/MCP tools/call normal/input/error tests. Exercise invalid exceptions, missing outputs and masking through explanation input/stdout/stderr/JSON/MCP.
- [x] Measure size/time/RSS deltas under the same environment/fixture/cache assumptions. Run relevant regressions plus final npm test/verify; document OS limits and commit for review. Coordinator independently passed 18 HTTP cases, one new metadata regression and scoped production/packed-consumer verification; see Task3 report. Remote CI is still a final integration gate.

### Task 4: Preview, explicit apply, verified restore for one Next setting

**Files:** create `src/protect.ts` with its tests; modify CLI options/help/README and 5-language messages; protection integration fixture. No protection tool in MCP: MCP inspection stays read-only.

**Interfaces:** `--protect-sourcemaps` is a preview-only CLI action. `--apply --expected-hash HASH` with that action explicitly applies the reviewed change. `--restore TRANSACTION_ID` restores an owned backup only if current file hash matches the applied content. Other mode combinations are errors. No interactive prompt/implicit acceptance in CI.

**Concrete safety contract (coordinator preparation; Task4 is still gated on Task3 review):**
- Select exactly one direct object export and one unambiguous literal setting, with no duplicate/computed/spread override. Absent/false is a no-op; unsupported wrappers or exports never execute configuration code to determine a replacement.
- Preview only the setting/token change with its relative path and location, not surrounding config/env values. The expected source hash is an explicit apply-approval token, not secret/artifact exposure evidence. Inspection and MCP never invoke this flow.
- Apply requires a tracked, Git-clean target (including index/worktree state), matching preview hash and verified in-root regular file. A missing Git repository, untracked target or ambiguous status is refusal, not implicit permission. Recheck source identity/content immediately before replacement; use an owned exclusive transaction lock to reject competing tool operations.
- Reject symlinked transaction storage, backup/metadata files and target paths. Use bounded, validated metadata and a restricted transaction ID, private permissions and exclusive creation; never follow a supplied metadata path outside the transaction/root or restore an arbitrary file.
- Backup is byte-exact and durable before config replacement. A failed apply reports whether the config changed. Restore validates root/target ownership and original/applied hashes, and refuses to overwrite post-apply user edits, corrupt backups or conflicting transactions.
- Verification may build and start only its own loopback production smoke process; clean it up on every exit. Never use a dev server as production evidence or stop/reconfigure a server the tool did not create. Failed verification attempts only hash-safe config rollback; report generated build output as a side effect, not as restored source/artifacts.

- [ ] Write failing tests for literal true→false in supported next.config.js/mjs/cjs/ts object exports, no-op false/absent, wrappers/multiple/ambiguous exports/computed settings unsupported, dirty Git file, preview/apply race, symlink escape, restore-after-user-edit refusal, failed build/verification with successful/failed rollback.
- [ ] Implement AST-located token replacement only for the single supported literal property. Preview shows diff, source hash, diagnostic impact, unchanged dependencies/network policy, generated build side effects and restore command. Never delete maps/sensitive files automatically.
- [ ] On explicit apply validate expected hash and clean Git target, create private original backup/transaction metadata, atomically replace the file; prevent concurrent transaction conflicts and path traversal. Failures report partial changes and rollback state.
- [ ] Build production locally, re-inspect maps and run loopback production smoke. Verification failure attempts only hash-safe restore and reports any restore failure. Assert all mutations remain inside temporary fixtures in tests.
- [ ] Run focused protection tests and package CLI/inspection regression. Coordinator checks safety/rollback and runtime side effects before integration. Commit with docs, never apply protection to the user's other projects.

### Task 5: Honest closure and synchronization

**Files:** TASKLIST, measurement/verification/support docs and GitHub issue checklists/comments.

- [ ] Map each implemented #2 requirement to a test/observation and identify remaining limits. Mark candidate evaluation separately from platform implementation. Record conditions to revisit deferred client tests and expansion candidates.
- [ ] Coordinator independently checks changed flow/unsafe inputs, fresh verification results and pack-consumer behavior; fix findings before integrating.
- [ ] Push reviewed commits, check CI and compare remote main/local main HEAD and clean worktree. Do not mark #1/#2 wholly done while mandatory requirements remain unverified or unimplemented.
