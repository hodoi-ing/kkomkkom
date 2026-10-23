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

## Coordinator regression — secret-bearing HTTP path metadata

Coordinator independently passed the 18 engine cases, then reproduced a known env value leaking through a served filename into HTTP id/file/messageVars/coverage metadata. The minimal shared output projection now runs **after raw exception matching and candidate/URL use**. It reuses `maskFreeText` for id, file, string messageVars, coverage path and reason. Provider patterns in filenames are masked without needing an env assignment. Enum/rule/message keys remain unchanged. Redacted occurrence IDs use non-secret ordinals (no hashes) so different raw paths that redact to one visible path remain separate observations with distinct IDs.

New regression `production HTTP redaction protects every output metadata field without collapsing observations or raw exceptions` uses two distinct known-value filenames and a provider-pattern filename that all redact to the same `.bin` path, plus an exactly excepted raw source-map filename. It asserts four distinct matched observations, raw candidate routing/exception application, engine/CLI text+JSON/MCP structuredContent/report/explanation-input non-disclosure, and no AI invocation.

Unique logs: `/tmp/opencode/kk-task3-redaction.YFKaYJ`.

- `TMPDIR=<above> node --test --test-reporter=tap --test-name-pattern='^production HTTP redaction' test/artifact-http.test.js` before fix: **exit 1, 0 pass / 1 fail**, `red.log`, expected `!output.includes(value)` failure.
- `npm run build`: first **exit 2** (`build.log`) because coverage reason is optional; added the undefined guard. Repeated build **exit 0**, `build2.log`.
- Same single new regression after fix: **exit 0, 1 pass / 0 fail**, `green.log`. The approved 18 engine cases were not repeated; integration/final verify will include this connection.
- Integration edits to `scripts/verify.mjs` are still WIP and excluded from this security-fix commit.

## Production / packed-consumer integration and final verification

`scripts/verify.mjs` reuses its original #1 flow and adds a scoped `--artifacts-only` route for new connections. All scratch fixture/pack/consumer paths now use unique `tmpdir()` directories (executions set `TMPDIR` under `/tmp/opencode`). Cached fixture dependencies are copied into the temporary fixture, rather than linking outside a Next/Turbopack root; a missing cache is an explicit failure, not an install into the repository fixture. Only temporary consumers install, using the local tarball plus npm `--offline`.

The new flow explicitly builds a temporary Next production app with browser maps, starts an owned numeric-loopback production process, checks static/HTTP CLI JSON and translated text, then checks local and packed-production-dependency MCP normal/input/config-error responses and stream survival. An intentional fake provider fixture tests blocking/masking; an exact temporary exception also tests normal CLI exit 0 and MCP `isError:false`. The harness restores that temporary config byte-for-byte. Known env and provider values stay absent from stdout/stderr/JSON/MCP/report/explanation input; no AI is invoked. Raw file snapshots are compared in memory (no secret-bearing digests), and baseline bytes remain unchanged. The owned server is stopped in `finally`.

Observed commands/results:

- `TMPDIR=/tmp/opencode/kk-task3-integration.RoBRys NEXT_TELEMETRY_DISABLED=1 node scripts/verify.mjs --artifacts-only`: **exit 0**, initial production/pack artifact connections passed, pack 75,153 B before README expansion, install 592 ms.
- `TMPDIR=/tmp/opencode/kk-task3-final.RHAfHP NEXT_TELEMETRY_DISABLED=1 npm run verify`: **exit 0**, **267 unit/regression tests** and all existing/new real production/MCP/pack checks passed. Pack **76,663 B**, offline production-consumer install **576 ms**. Raw log committed at [`verification-logs/2026-10-22-task3-verify.txt`](verification-logs/2026-10-22-task3-verify.txt). Full `npm test` was not separately run; this was the one full verify execution.
- After replacing the read-only harness's prior SHA source fingerprint with an in-memory exact byte snapshot, a scoped recheck initially exited **1** during dependency copying, before artifact checks, due to **ENOSPC** (`/tmp/opencode/kk-task3-byte-snapshot.QzsRAd/scoped.log`). `/tmp` was a 2.9 GiB tmpfs with only 311 MiB free. Removed only this task's generated measurement fixture/consumer `node_modules` copies, retaining all measurement logs/build/output files; free space became 708 MiB.
- `TMPDIR=/tmp/opencode/kk-task3-byte-snapshot.O0dqNC NEXT_TELEMETRY_DISABLED=1 node scripts/verify.mjs --artifacts-only`: **exit 0**, latest byte-snapshot helper, normal/error/masked paths, production browser maps and packed consumer all passed, same **76,663 B** pack, install **580 ms**. Raw log: [`verification-logs/2026-10-22-task3-scoped.txt`](verification-logs/2026-10-22-task3-scoped.txt). No second full test/verify was run.
- `/tmp/opencode/kk-task3-measure.YNCOXW/measure.mjs`: **exit 0**; pack/install/static/HTTP/fresh each exit 0. Original driver/commands/time logs, fixture/cache assumptions and limitations are recorded in [`measurements-2026-10-22.md`](measurements-2026-10-22.md), Task3 latest section.

README Korean/English documents origin-only opt-in syntax, runtime restrictions, actual-file versus referenced-map evidence, uncertainty, limits, output metadata masking and unsupported deployment boundaries. Linux/WSL is the tested environment. No external deployment/publish/public conversion, other-project source edits, new runtime dependency/model/agent, or Task4 protection operation occurred.

**Task3 implementation evidence is ready for coordinator final independent review; `[ ]` remains until coordinator PASS.** Earlier pending lists in this document are historical status at the engine milestone, not claims that these integration checks are still unexecuted.

## Coordinator final PASS (2026-10-23)

- Previously independently ran the 18 HTTP cases successfully; did not repeat them after approval.
- Independently ran the new `^production HTTP redaction` regression: **1 pass / 0 fail, exit 0**. Raw routing/exception matching and separate masked observations remain intact.
- Independently ran `node scripts/verify.mjs --artifacts-only` with `TMPDIR=/tmp/opencode/kk-task3-coordinator.ec2x7wx8`: **exit 0**, actual browser-map production build, owned loopback server, repo/production-only packed CLI/MCP success/input/config-error/masking/explanation input, and exact byte preservation all passed. Log: `/tmp/opencode/kk-task3-coordinator.ec2x7wx8/scoped.log`.
- Reviewed the original full 267-test verification log, measurement provenance/time logs, snapshot/masking flow, and `7c0012e`'s explicit CI fixture install plus offline-consumer cache preparation. The isolated tarball-only cache reproduction establishes why the metadata step is necessary; registry access is explicit in preparation only.
- Task3 is approved and Task4 may start. Remote Node20/22/24 CI remains the final integration gate; no claim of Windows/macOS production checks or agent-specific MCP-client installation is made.

## CI preparation correction (2026-10-23)

Coordinator identified that fresh GitHub e2e runners only installed root dependencies while verification now intentionally refuses to auto-install the fixture. `.github/workflows/test.yml` now explicitly runs `npm ci --prefix fixtures/mini-app --no-audit --no-fund` before verify. It also primes `typescript@<package.json runtime range>` with `npm cache add`, so the packed consumer keeps strict `--offline` behavior. Using the range, rather than only the locked version, prepares both range metadata and whichever satisfying tarball the consumer selects. No product auto-install, hidden `prefer-offline` network fallback or new dependency was added. README Korean/English preparation commands match CI; `verify` already includes unit tests.

Reproduction used a new `/tmp/opencode/kk-task3-ci-cache.Ytzjxk/cache` populated **only** with lockfile-integrity-addressed package content blobs from the existing npm cache, with no registry metadata/index copied. Root and fixture installs were isolated copies; the repository's `node_modules`/fixture were not installed into.

- Root `npm ci --offline --no-audit --no-fund --cache <isolated cache>`: **exit 0**.
- Fixture `npm ci --offline --no-audit --no-fund --cache <isolated cache>`: **exit 0**.
- Local `npm pack --ignore-scripts --json --pack-destination <unique pack dir> --cache <isolated cache>`: **exit 0**.
- Fresh consumer `npm install --offline --ignore-scripts --omit=dev --no-audit --no-fund --cache <isolated cache> <local tarball>`: **exit 1 / ENOTCACHED**, explicitly missing the TypeScript registry response despite successful root/fixture ci (RED).
- Explicit `npm cache add 'typescript@^5.9.3' --cache <isolated cache>`: **exit 0**. This preparation step was allowed to contact the registry; it is not an offline or zero-download claim.
- Same offline install in a different new consumer directory: **exit 0**, TypeScript **5.9.3** installed (GREEN).
- Installed PyYAML parsed the workflow, preparation order was checked and each e2e `run` command passed `bash -n`: **exit 0**. No parser dependency was installed.

Drivers `/tmp/opencode/kk-task3-ci-cache.Ytzjxk/{prepare,prime}.mjs` and per-command stdout/stderr remain for inspection; raw summary/result/error evidence is committed at `verification-logs/2026-10-23-task3-ci-cache.txt`. Neither the approved 18 engine cases nor the metadata regression nor full verify was repeated. Actual Node 20 GitHub runner execution remains for coordinator remote/PR verification. Task3 `[ ]` and Task4 wait remain unchanged.
