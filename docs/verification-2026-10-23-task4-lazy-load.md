# Task4 final opt-in loading contract

Coordinator evidence accepted without rerun: Task4 focused **32/32 exit 0** and protect-only actual production/repo+packed CLI/MCP/user-edit refusal/byte-exact restore **exit 0**, `/tmp/opencode/kk-task4-coordinator.cdlaoe_w/{focused,protect-scoped}.log`; pack 92,800B, consumer install 538ms. These are coordinator observations, not this worker's new execution.

Removed the top-level CLI protection import; the same named bindings now use `await import("./protect.js")` inside the protection branch, after runtime option validation. No other mode or MCP implementation changed.

One new behavior regression copies dist into a uniquely owned temporary fixture, provides the package/module resolution context and replaces only the copied protect module with valid exports plus a top-level throw sentinel. It verifies:

- Help exits 0 without initializing protection.
- Normal-mode startup reaches its expected no-routes error (the fixture deliberately has no routes), not the sentinel.
- Artifact CLI returns schemaVersion 2 without initializing protection.
- MCP performs artifact inspection and later ping without initializing protection.
- Invalid protection combinations are rejected before initialization.
- A valid explicit protection preview does initialize the sentinel.

The source dist is never overwritten; the fixture owner cleans only its copy.

Commands, logs `/tmp/opencode/kk-task4-lazy-protect.ewZeCK/`:

1. `node --test --test-name-pattern='^protection module loads only' test/protect-cli.test.js` → **RED, exit 1, 0/1 pass** (`red.log`): even help initialized the sentinel due to the top-level import.
2. `npm run build` → **exit 0** (`build.log`).
3. Same new-test command → **GREEN, exit 0, 1/1 pass**, no skipped tests (`green.log`).
4. `git diff --check` → **exit 0**.

Two bookkeeping patch attempts encountered concurrent coordinator edits (Task4 checkbox and verification-document heading). Neither applied partial changes. Rather than overwrite coordinator work or repeat speculative patches, this distinct ledger records only the new change; existing independent PASS records are preserved.

No completed 32-case suite, real integration, full verify/test, production build, pack/install or other model/reviewer repeated. No user project protection, push/main/publish/deployment. The worker did not alter the coordinator's Task4 checkbox. After this small local commit/report the worker is idle; final remote CI/integration remains coordinator-owned.
