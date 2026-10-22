# Task4 protection — implementation ledger

Plan: `docs/superpowers/plans/2026-10-22-issue2-artifacts.md`, Task4; approved safety contract `8d7b1f4`. Starting HEAD `5666c4d`, branch `issue2/artifacts`.

## Safety engine checkpoint

- Actual running session queried through the local OpenCode API: `openai/gpt-6.1-sol`, variant `medium`. No additional agent/model invocation.
- New `src/protect.ts` exposes AST-only preview, explicit hash-approved apply, and hash-safe restore. CLI and post-apply production verification are not connected at this checkpoint.
- Direct object `module.exports`/`export default`, including TS `satisfies`/`as` type annotation, only. Non-type top-level executable statements, indirect object variables, wrappers, spread/computed/duplicate keys, multiple config files/exports and parser errors are unsupported. This deliberately supports less than arbitrary valid Next config; no config execution during preview.
- Preview returns only fixed config basename, SHA-256 approval token and the `true`→`false` token with 1-based line/column and offsets. No surrounding source/config/env is returned; byte-preserving replacement retains CRLF and original mode.
- Apply checks HEAD/index/raw worktree equality (including hidden assume-unchanged/skip-worktree edits), rechecks immediately before atomic rename, rejects symlinked ancestors/targets/storage, and acquires an exclusive owned lock. No stale-lock deletion.
- Private exclusive backup/metadata files are synced before replacement, with directory syncs; restore bounds metadata to 16KiB, validates transaction/root identity and fixed target basename, validates backup hash and the only permitted token transformation, and refuses current bytes that differ from the applied hash.
- OS-level residual: the final check and rename are separate filesystem syscalls. The lock excludes cooperating protection commands, not a hostile process with the same filesystem permissions. Windows/macOS directory sync behavior remains unverified.

Commands/output (all new mutations limited to uniquely named `/tmp/opencode/kk-protect-*` temporary Git fixtures, each cleaned by its owning test):

1. `node --test test/protect.test.js` → RED, six failed assertions for missing exported safety engine; `/tmp/opencode/kk-task4-engine-20261023/red.log` (initial shell displayed tail, did not propagate test exit; log explicitly records six failures).
2. `npm run build` → exit 2, TypeScript narrowing/stat overload errors; `build.log`. Corrected explicit `never` function declaration and `Stats` return annotation only.
3. `npm run build && node --test test/protect.test.js` → exit 0, six passed; `build2.log`, `green.log`.
4. Added concurrency/hidden-Git-change, forged-applied-hash and metadata-permission defense coverage. `node --test test/protect.test.js` → exit 0, nine passed; `engine-final.log`. These three extend already implemented safety behavior, not new post-hoc implementation.

No existing golden/full suite, production builds, packed consumers, MCP, external user project application, push, publish or deployment run at this checkpoint. Task4 remains unchecked pending CLI/verification integration and coordinator PASS.

Next: runtime CLI argument tests; verification success/build failure/smoke failure/hash-safe rollback success/refusal tests; owned production process reuse; real Next and packed integration; focused tests throughout and one final `npm run verify` including the full suite.

## CLI / owned verification checkpoint

- Added explicit preview/apply/hash/restore CLI modes; all inspection/write/explanation/reuse/port options conflict with protection. JSON and five-language impact/side-effect/restore notes disclose config-only scope and generated build output. No MCP protection tool added.
- Reused `runBuild`, bounded `readBody`, and the existing Next server/process-group lifecycle. `startProductionServer` shares lifecycle code but always spawns `next start --hostname 127.0.0.1` and rejects reuse. Optional AbortSignal support preserves existing build/dev behavior while allowing the protection owner to wait for SIGINT/SIGTERM cleanup and hash-safe rollback before exiting 130/143.
- Verification uses build → owned loopback smoke → existing artifact/static+HTTP inspection; incomplete coverage, source-map findings or suppressed source-map exceptions fail verification. Output records build/artifacts/smoke/cleanup and config rollback separately. Existing generated build output is not rolled back.
- Added private active-transaction ownership, preventing an old transaction from restoring a later identical apply. The lock now spans apply, build, smoke, inspection, cleanup and rollback; concurrent restore refuses while verification runs.
- TDD logs under `/tmp/opencode/kk-task4-engine-20261023/`: `verification-red.log` (4 missing-API failures), `cli-red.log` (3 unsupported-argv failures), `interrupt-red.log` (config remained false on SIGINT), `stale-red.log` (old transaction unexpectedly accepted), `verification-lock-red.log` (concurrent restore unexpectedly accepted), `exit-mode-red.log` (unsupported JSON code and full Unix mode preservation failures).
- Verification fixture debugging: the first fake success fixture lacked app sources (`source-missing`); adding a minimal app exposed its fake HTTP server returning root HTML for chunk requests (`http-byte-mismatch`). The fixture now serves exact emitted chunk bytes. Diagnostic logs retained; no relaxation of production verification to force green.
- Final focused command: `npm run build && node --test test/protect.test.js test/protect-verification.test.js test/protect-cli.test.js` → **exit 0, 20 passed / 0 failed** (`cli-final-build.log`, `cli-final.log`). No existing golden/full suite repeated.
- Coordinator report attempt: `herdr agent prompt w1:p4 ...` was rejected with `agent_blocked` before submission. Read-only inspection showed an unrelated pending GitHub PR permission. Did not answer the permission prompt or interrupt that agent; this ledger/TASKLIST carries the report until it becomes available.

Remaining: real Next/packed CLI protection integration; README/help contract and limits; inspect rollback-finalization failure reporting; final single full verify; coordinator independent PASS and remote integration/CI. Task4 remains unchecked.

## Real integration and final implementation verification

Environment: Linux/WSL, Node **v26.10.0**, npm **12.1.0**. Node20/22/24 remote CI is a separate coordinator gate, not inferred from the local runtime. No other agent/model was called.

### Additional safety regressions

- MCP explicitly rejects protection arguments before inspection; the schema still exposes only the read-only inspection tool. `mcp-protection-red.log` → `mcp-protection-green.log` (one new focused test, exit 0).
- Last pre-replacement identity checks now include mode/mtime/ctime, not only inode/content. A real filesystem-watch race changes permissions after backup and before replacement: `final-recheck-red.log` → GREEN in `focused-final.log`. Restore also refuses later chmod even when bytes still match: `restore-mode-red.log` → GREEN in `durability.log` and final suite.
- Backup refusal and rollback-finalization failure are separate outcomes. A corrupt backup leaves the applied config untouched; a permissions-induced active-pointer cleanup failure reports config restored **and** `rollbackFailureReason: restore-finalization-failed`, without claiming storage cleanup succeeded. `rollback-detail-red.log` → GREEN in `focused-final.log`.
- Critical artifact findings must fail protection verification even when source maps are absent and exact HTTP bytes match. `critical-red.log` → GREEN in `focused-final.log`.
- Next's installed `verify-typescript-setup.js` explicitly skips its missing-TypeScript auto-installer in CI. Protection builds now pass `CI=1` via the existing build helper; default inspection/build behavior is unchanged. `no-install-red.log` (`unset` vs `1`) → GREEN in the final suite. This is not a network sandbox for arbitrary project build/config code.
- Final review found that schema-valid metadata could name another allowed config basename with identical applied bytes. Added that malicious-metadata regression and bound the exact metadata bytes to a private active-record SHA-256. `metadata-binding-red.log` → `metadata-binding-green.log`, **24/24 focused pass**. Target/root/hash/schema validation and backup-derived token validation remain in place; the metadata hash is not a substitute for them.
- Directory durability review added a root directory sync before replacement, so the new `.kkomkkom` parent entry is durable too. Installed `strace` (no install performed) observed original backup fsync → metadata fsync → transaction/protection/.kkomkkom/root directory fsync → active record fsync → temporary file fsync → target rename → root fsync. Original syscall trace: `/tmp/opencode/kk-task4-engine-20261023/durability.strace`; focused test output `durability.log` (2/2 pass, exit 0). This demonstrates syscall ordering, not power-loss or Windows/macOS durability testing.

### Commands and retained output

1. `TMPDIR=/tmp/opencode/kk-task4-real.NrQOXO NEXT_TELEMETRY_DISABLED=1 node scripts/verify.mjs --protect-only` → **exit 0**. One owned temporary Next dependency tree, initial real browser-map build, repo and offline production-only packed CLI preview/apply/owned production verification/restore-user-edit refusal/exact restore; MCP rejects protection arguments and stays alive. Pack 87,629B, offline consumer install 674ms. Original output: `docs/verification-logs/2026-10-23-task4-protect-scoped.txt`.
2. Initial end-of-task `npm run verify` under `/tmp/opencode/kk-task4-final.amXnK7` → **exit 1**. All actual production/MCP/artifact/protection/packed integration checks passed; unit suite was 290 pass / 1 fail because the common i18n test fixture did not supply the new `{changed}` variable. The actual CLI passes it. Updated only that shared test's vars, then `node --test --test-name-pattern='^every language has every message' test/i18n.test.js` → **1/1 pass, exit 0**. Both logs retained as `2026-10-23-task4-verify.txt` and `2026-10-23-task4-i18n-fixture.txt`.
3. Metadata binding is a subsequent product-code safety fix, not merely a test-fixture change. After its RED→GREEN and **24/24 focused pass**, reran the final whole gate rather than calling the failed attempt a PASS. This is the sole repair rerun, not a per-stage full-suite loop; no separate `npm test` was run.
4. `TMPDIR=/tmp/opencode/kk-task4-final-fixed.0sD35h NEXT_TELEMETRY_DISABLED=1 npm run verify` → **exit 0, 291 unit/regression tests + all real production/MCP/artifact/protection/packed checks passed**. Original output: `docs/verification-logs/2026-10-23-task4-verify-final.txt`. Final focused output: `docs/verification-logs/2026-10-23-task4-focused.txt`. Pack **90,973B**, offline consumer install **643ms**; these are observations from this run, not a new same-cache cost benchmark.

All protection applies/restores were confined to newly owned temporary Git fixtures. Large Next trees were created sequentially and cleaned by the harness that created them. No source/config/env/baseline changes to a real user project, no new production dependency, no automatic product installation, no push/main change, no publish/deployment/public conversion. Technical README/help contract updated; no patina backend was called because the user's explicit no-other-model/agent rule takes precedence (no patina receipt/verified-rewrite claim).

### Coordinator handoff — independent PASS still required

Review baseline `5666c4d`; safety checkpoint `0b64dae`, CLI/verification checkpoint `3894c73`, then the final integration/safety commit containing this ledger. Task4 remains **[ ]** until coordinator PASS. Do not rerun completed Task3/old goldens mechanically; final verification above already includes the full suite.

Focus: AST support/refusal and token-only output; HEAD/index/raw-worktree + final identity checks; backup/metadata/active hash binding and symlink/storage boundaries; stale/competing transaction refusal; whole-workflow lock; config-only rollback including storage-finalization errors; owned `next start` cleanup and SIGINT/SIGTERM; MCP read-only refusal; real/packed source/env/baseline preservation. Known limits: no Windows/macOS or power-loss validation; no sandbox against project build side effects or same-permission processes between final check/rename; root `.env*` masking is not all possible secret knowledge.

The coordinator remains blocked at an unrelated GitHub PR permission prompt. Report submission was rejected before delivery; no approval keys, second agent or model were used to bypass that state. This committed ledger and top-priority TASKLIST are the durable report. Remaining owner work: independent review/PASS, Task5 extension-demand/cost closure, remote Node20/22/24 CI and integration/main/local synchronization. No user approval was requested mid-implementation.
