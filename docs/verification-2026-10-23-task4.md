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
