# Issue #2 Task3 — engine milestone, integration pending

## Scope and decisions

Base: coordinator-approved `2bfe2e5`, HTTP contract `6b6d6b6`. Task3 only. Task4 remains blocked on coordinator instruction. No push, publish, public conversion, external deployment or additional model/agent invocation.

- New `artifact-http.ts` owns canonical loopback-origin validation and GET-only verification. CLI `--production-url` and MCP schema/runtime `productionUrl` are opt-in and require artifacts mode. Runtime engine validation happens before config reads/build side effects.
- Ruling: accept origin-only URLs, not base paths — the approved interface specifies an origin, and candidate URLs derive solely from verified served-file paths. Canonical IPv4 `127.x.x.x`, `[::1]` and `localhost` are accepted; localhost becomes numeric `127.0.0.1` without DNS. Numeric/hex/octal/short-host tricks, other schemes/hosts, credentials, query and fragment are rejected without echoing input.
- Candidates are raw buffers from the existing bounded scan of verified `public/` and supported `.next/static/` files. No source graph/env/config file becomes a candidate, and references are never independently fetched. There is no second local file read. Static mode retains no candidate buffers.
- Candidate URLs encode individual path segments; identical URL aliases deduplicate, conflicting bytes at one URL are unsupported and not fetched. At most 50 distinct URLs, five workers, 5 seconds through body completion and a 60-second overall deadline. Remaining targets, failures, limits and no-candidate cases are explicit coverage.
- The new raw-byte reader observes EOF at exact 1 MiB, rejects overflow and cancels unread streams. A shared accepted-payload byte counter never exceeds 32 MiB, including five concurrent readers; excess chunks are refused rather than retained. This is a processed HTTP payload budget, not a measurement of network/OS buffering or download bytes. It is separate from the local-file budget.
- Only complete 2xx byte equality creates an informational `local-production-http` observation for the actual matched file. Static findings remain separate, including on 404. A JS reference match never claims its map was served. Server/project identity and Internet deployment remain unverified. No content/digest is emitted.
- The existing text `readBody` contract for issue #1 is unchanged. Artifact bounded local reads now have a raw-buffer primitive with the old text/binary filtering retained by the wrapper; all original local stat/size/range/budget checks remain.

## Commands and observed results

Unique log/fixture directory: `/tmp/opencode/kk-task3-http.uM9AZQ`. Every test command below used this as `TMPDIR`.

| Command | Actual result | Log |
|---|---|---|
| `node --test --test-reporter=tap --test-name-pattern='^production HTTP (validates\|matches\|leaves\|distinguishes\|has\|caps\|response\|MCP)' test/artifact-http.test.js` before implementation | exit 1, 0 pass / 13 fail | `red.log` |
| `npm run build` | exit 0 | `build.log` |
| Same 13-case command after initial engine | exit 0, 13 pass / 0 fail | `green1.log` |
| `node --test --test-reporter=tap --test-name-pattern='^production HTTP caps accepted payload bytes' test/artifact-http.test.js` before extracting the counted reader | exit 1, 0 pass / 1 fail | `budget-red.log` |
| `npm run build` after reader/timer changes | exit 0 | `build2.log` |
| `node --test --test-reporter=tap test/artifact-http.test.js` | exit 1, 16 pass / 1 fail: reference-JS fixture still served map bytes, so exact equality correctly failed | `focused.log` |
| `node --test --test-reporter=tap --test-name-pattern='^production HTTP \|^every language has every message with no unfilled placeholders$' test/artifact-http.test.js test/i18n.test.js` after fixing only the fixture response and adding alias-conflict coverage | exit 0, 19 pass / 0 fail / 0 skipped | `milestone.log` |

The regex alternation characters in the table are escaped only for Markdown; the executed shell regex used ordinary `|` characters. The erroneous reference fixture response was changed to the actual JS bytes; the file-specific observation assertions were retained.

Coverage includes canonical URL/runtime malicious arguments; real numeric-loopback GET/header behavior; encoded paths; raw binary differences; SPA/redirect/404/truncated/prefix mismatches; exact body boundary; empty/missing output; boundary symlink refusal; source/external-reference exclusion; no implicit HTTP in static mode; URL dedupe/conflicts; 50 targets/five concurrent requests; exact 32 MiB and next-chunk refusal/cancellation, also five concurrent counted readers; real loopback headers/partial-body stall at 5 seconds; separate controlled 5s/60s timer callbacks; MCP schema/error-stream survival/normal call; CLI mode/errors, all five languages and value-free output. Timer callback tests fire only one selected scheduled callback, not a 60s tick that also expires the 5s timer.

## Still pending — do not mark Task3 complete

- Real temporary Next production build → static → explicitly started loopback HTTP.
- Reuse/extend `scripts/verify.mjs` for packed production-dependency consumer CLI/MCP success/input/error, masking across report/JSON/MCP/explanation input, and actual baseline/source preservation.
- Same fixture/cache package size, install cost, static/HTTP/fresh time and max RSS, raw logs and measurement limitations.
- README/support/measurement documentation and one final `npm run verify` (includes full tests; no separate duplicate full `npm test`).
- Coordinator independent milestone review and final Task3 PASS. Existing completed Task2/2.1 tests were not separately rerun during this milestone; final integrated verification is still pending.
