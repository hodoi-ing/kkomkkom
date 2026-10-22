# Issue #1 integration verification — 2026-10-22

Environment: Linux/WSL (Ubuntu), Node.js v26.10.0, npm 12.1.0, Next.js 16.4.2 in `fixtures/mini-app`, TypeScript 5.9.3 (package) / 7.0.2 (fixture). Windows and macOS were not tested.

## Final integration

| Command | Exit code | Result | Full log |
|---|---:|---|---|
| `npm run verify` | 0 | build + 197 unit/regression tests + real fixture e2e + production build + MCP + packed consumer | [2026-10-22-npm-verify.txt](verification-logs/2026-10-22-npm-verify.txt) |

`npm run verify` runs `npm run build`, every `test/*.test.js` file, then the real-fixture integration checks below. The 197 count is unit/regression test cases, not real applications. `npm test` was not run separately because `verify` already includes the full unit suite.

The run passed these integration checks on the copied fixture (not only `--fast`):

- real `next build` with `coverage.status=complete`, exit 0
- measured weights for `/` and `/checkout`, both `method=manifest-file`
- `.next/BUILD_ID`, `.next/build-manifest.json` and app client-reference manifests exist
- a default non-fast check changes neither `app`/`lib`/config source hashes nor the baseline bytes
- `--update` stores measured page weights and `manifest-file`
- a later default check leaves `.kkomkkom/baseline.json` byte-identical
- MCP `tools/call`: normal run, invalid input, non-Next project, invalid config field, and stream survival after errors
- `npm pack` tarball contains `dist` but not `src`/`test`; tarball was 52,950 bytes
- production-only consumer install (no dev dependencies), 558 ms from the local npm cache; `typescript` present, `@types/node` absent
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

## Task 5 review findings now covered by regressions

1. Unreadable secret sources are no longer reported as a successful scan. `ENOENT` on an optional scan directory stays silent, while other read errors on a source file, source directory, root `.env`, or project root append `secrets` coverage `failed`/`read` with a root-relative path. Readable files are still scanned, secret values never appear in findings or coverage, `--strict` exits 1, and `--update` is refused with the baseline bytes unchanged.
2. An unreadable required route source (file or directory) is a sanitized `errSourceRead` tool error (exit code 2 path) instead of an empty source that could hide API behavior. A manual CLI probe with `chmod 000 app/api/x/route.ts` printed `Could not read the route source app/api/x/route.ts` and exited 2.
3. Unconfirmed 4xx responses (for example 400, 408, 429) now record `api-auth` coverage `failed`/`http-<status>` instead of `checked`. Coverage becomes incomplete and `--strict` exits 1. The deliberate 405 for a statically GET-less route stays `checked`/`method-not-allowed`, and 401/403/redirect/5xx handling is unchanged.

These regressions were red before the fix (6 focused failures) and green after; the final `npm run verify` above includes them.

## Limitations

- Windows and macOS are untested (process termination, paths, `npm pack` install).
- Consumer install was measured from a warm local npm cache; cold network time was not measured.
- The production build was Next.js 16.4.2 only. Legacy size-table parsing is unit-tested but was not exercised against a real older Next build.
- Agent-specific MCP client installation and connection remain deferred; only the stdio server and `tools/call` were exercised.
- The unreadable-path regressions use `chmod`; they are skipped on Windows and when the test process runs as root.
- Redaction and auth/write analysis keep their documented limits; this verification demonstrates the implemented behavior, not deployment safety.
