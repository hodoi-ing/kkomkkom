# Issue #1 integration verification — 2026-10-22

Environment: Linux/WSL (Ubuntu), Node.js v26.10.0, npm 12.1.0, Next.js 16.4.2 in `fixtures/mini-app`, TypeScript 5.9.3 (package) / 7.0.2 (fixture). Windows and macOS were not tested.

## Final integration

| Command | Exit code | Result | Full log |
|---|---:|---|---|
| `npm test` | 0 | 190 tests, 190 pass, 0 fail, 0 skipped | [2026-10-22-npm-test.txt](verification-logs/2026-10-22-npm-test.txt) |
| `npm run verify` | 0 | build + 190 unit tests + real fixture e2e + production build + MCP + packed consumer | [2026-10-22-npm-verify.txt](verification-logs/2026-10-22-npm-verify.txt) |

`npm test` runs `npm run build` and every `test/*.test.js` file. The 190 count is unit/regression test cases, not real applications.

`npm run verify` passed these integration checks on the copied fixture (not only `--fast`):

- real `next build` with `coverage.status=complete`, exit 0
- measured weights for `/` and `/checkout`, both `method=manifest-file`
- `.next/BUILD_ID`, `.next/build-manifest.json` and app client-reference manifests exist
- a default non-fast check changes neither `app`/`lib`/config source hashes nor the baseline bytes
- `--update` stores measured page weights and `manifest-file`
- a later default check leaves `.kkomkkom/baseline.json` byte-identical
- MCP `tools/call`: normal run, invalid input, non-Next project, invalid config field, and stream survival after errors
- `npm pack` tarball contains `dist` but not `src`/`test`; tarball was 51,892 bytes
- production-only consumer install (no dev dependencies), 495 ms from the local npm cache; `typescript` present, `@types/node` absent
- packed consumer CLI and MCP `tools/call` both returned `schemaVersion: 2` and complete coverage

## Production artifact spot check

A separate copied fixture was built with `node node_modules/next/dist/bin/next build` (exit 0), then measured through the built `dist/build.js`:

```json
{
  "/checkout": { "firstLoadJs": 568618, "method": "manifest-file" },
  "/": { "firstLoadJs": 568618, "method": "manifest-file" }
}
```

The following files were produced and read: `.next/BUILD_ID`, `.next/build-manifest.json`, `.next/server/app/page_client-reference-manifest.js`, `.next/server/app/checkout/page_client-reference-manifest.js`.

## Reproduced Task 4 failures now covered by regressions

1. A legacy baseline without `method` is loaded but page sizes are not compared. Only two measurements with the same recorded method are compared. The report tells the user to run `--update`.
2. A baseline lock with a live PID or an old mtime is never auto-deleted. The save waits 5 seconds and fails with an explicit error that points to `.kkomkkom/baseline.json.lock` for manual inspection. Release only removes the lock created by the same save.
3. A discovered page with no measurement (including an empty build result or a partial page set) produces `build` coverage `failed`, makes `--strict` exit 1, and refuses `--update` while preserving the original baseline bytes. API-only projects do not get invented page checks.

## Limitations

- Windows and macOS are untested (process termination, paths, `npm pack` install).
- Consumer install was measured from a warm local npm cache; cold network time was not measured.
- The production build was Next.js 16.4.2 only. Legacy size-table parsing is unit-tested but was not exercised against a real older Next build.
- Agent-specific MCP client installation and connection remain deferred; only the stdio server and `tools/call` were exercised.
- Redaction and auth/write analysis keep their documented limits; this verification demonstrates the implemented behavior, not deployment safety.
