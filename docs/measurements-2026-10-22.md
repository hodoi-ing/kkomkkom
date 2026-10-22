# Issue #2 Task 1 — measured baseline and support contract (2026-10-22)

This file records what was actually measured, not a conversion from source kilobytes to installed megabytes. All commands below were run on the checked-out repository; the working commit before the artifact feature was `df10e36` (`main` after issue #1). The artifact-feature measurements were taken from the same working tree after Task 2 was implemented and are labelled separately.

## Environment and provenance

| Item | Value |
|---|---|
| OS | Linux/WSL2, kernel 6.18.33.2-microsoft-standard-WSL2, x86_64 |
| CPU / memory | 12th Gen Intel Core i5-12400F, 12 logical CPUs, 5 GB reported RAM |
| Node / npm | Node v26.10.0, npm 12.1.0 |
| Package under test | `kkomkkom@0.1.0`, commit `df10e36` (pre-feature), TypeScript 5.9.3 |
| Fixture | `fixtures/mini-app`, Next.js 16.4.2, copied to a unique `mktemp` directory (492 MB including `node_modules`/`.next`) |
| Logs | [`measurement-logs/2026-10-22-baseline.txt`](measurement-logs/2026-10-22-baseline.txt) |

Wall time and maximum RSS come from `/usr/bin/time -v`. The RSS is the measured CLI process (and its reaped child), not a whole-tree sum; separately spawned Next build grandchildren are not included. Wall time includes Node process startup. Each measurement used its own copied fixture, not the repository fixture, and the temporary directories were kept for inspection.

## Package size

| Observation | Compressed tarball | Unpacked bytes | Entries | Note |
|---|---:|---:|---:|---|
| Pre-parser observation, commit `f9a21ff` (reused) | 38,691 B | 120,918 B | 41 | `npm pack --dry-run --ignore-scripts --json`; zero declared runtime dependencies at that commit |
| Issue #1 reviewed package, pre-artifact feature | 52,950 B | 171,022 B | 47 | current `dist`, one runtime dependency (`typescript`) |
| Artifact feature working tree | 62,545 B | 211,124 B | 49 | +9,595 B compressed (+18.1%), +40,102 B unpacked (+23.4%), +2 entries |

The dry-run JSON from this npm version is a keyed object, not an array; a parser must accept both shapes. `npm pack --ignore-scripts` was used so the recorded bytes describe the existing `dist`, not a fresh build. The post-feature tarball overwrote the same-named temporary file; the pre-feature size is recorded above and in the log.

## Production install cost

Local tarball install into a fresh consumer with `--omit=dev --ignore-scripts --prefer-offline --no-audit --no-fund`:

| Measurement | Wall | Max RSS | Installed `node_modules` | Packages |
|---|---:|---:|---:|---:|
| Pre-feature | 0.53 s | 195,744 KB | 23,797,200 B | `kkomkkom` + `typescript` |
| Artifact feature | 0.61 s | 207,312 KB | 23,837,307 B | `kkomkkom` + `typescript` |

`typescript` accounts for 23,625,066 B of the installed tree; the package's own unpacked bytes account for 171,022 B. The install used a warm local npm cache. Download bytes, registry latency, cold-cache install and Windows/macOS install were **not measured**; no download size is inferred from the unpacked size.

## Fixed-fixture check cost

Commands were run as `node /home/dev/workspace/next-preflight/dist/cli.js … --json` from a unique copy of `fixtures/mini-app`. The fixture contains a dynamic `/api/orders/[id]` route without `sampleParams`, so both normal modes report `api-auth failed/sample-missing` and `coverage.status=incomplete`; that is fixture behaviour, not a new failure.

| Mode | Command | Wall | Max RSS | Exit | Result |
|---|---|---:|---:|---:|---|
| HTTP fast (no build) | `--fast --port 3410 --json` | 2.18 s | 480,984 KB | 0 | `build` skipped/`fast`; dev server + loopback GET checks |
| Full build | `--port 3411 --json` | 6.46 s | 987,676 KB | 0 | real `next build`; manifest page weights; new `BUILD_ID` |
| Static artifacts (post-feature) | `--artifacts --json` | 0.21 s | 121,832 KB | 0 | `coverage=complete`; `static-only/build-freshness-unknown`; 0 findings |
| Explicit fresh artifacts (post-feature) | `--artifacts --fresh --json` | 1.74 s | 370,696 KB | 0 | warm-cache `next build`; `BUILD_ID` changed; `coverage=complete`; 0 findings |

The static artifacts mode does not start a server, build, call an AI CLI or install anything. The 0.21 s figure is the standalone inspection cost; it is not a substitute for HTTP or build coverage, and their scopes differ. The fresh run was faster than the earlier full-build run because Next's build cache was warm in the copied fixture. The pre-feature `--fast`/full numbers used the `df10e36` `dist`; the static/fresh numbers used the Task 2 working tree.

## Network and cache policy

| Measurement | Network policy |
|---|---|
| `npm pack` (both) | local filesystem only; `--ignore-scripts` |
| Consumer install | local tarball plus warm npm cache; `--prefer-offline`; no intentional registry request; download bytes not instrumented |
| `--artifacts` | no HTTP, no server, no build, no install; only local file reads under `public/` and `.next/static/` |
| `--fast` | loopback dev server and loopback GET only; no cookies/Authorization; external requests are not made intentionally |
| Full build / `--fresh` | loopback checks plus the project's local Next build with `NEXT_TELEMETRY_DISABLED=1`; external network use by the build was not instrumented |

No hidden network download is required by the static artifact check. Whether a user's Next build performs external work (fonts, telemetry beyond the disabled flag, remote caches) remains outside this measurement.

## Supported and unsupported contract

Supported initially:

- default Next production output boundaries `public/` and `.next/static/`;
- no `next.config.*`, or a config that can be read as text with a supported literal `distDir`/`output`/`productionBrowserSourceMaps` setting;
- Node.js >= 20 (local Node 26; CI on Node 20/22/24 was already green for issue #1);
- Linux/WSL for the measured commands above.

Not claimed as supported or verified:

- custom `distDir`, `output: "export"`, `output: "standalone"`, multiple/ambiguous configs, computed config values — reported as `unsupported` coverage, never as clean success;
- symlink escape, unreadable files, oversized files, total-budget/count-limit, missing or stale output — visible `failed`/`unsupported` coverage;
- actual HTTP serving, CDN/proxy rules, `--production-url` evidence — planned for Task 3, not measured here;
- `.next/server` maps as public evidence — explicitly excluded from the served boundary;
- Windows, macOS, cold-cache/network install cost, monorepo layouts and non-Next frameworks;
- agent-specific MCP installation/connection tests remain deferred; only the local `tools/call` path is exercised.

## What the numbers mean

The artifact feature adds about 9.6 KB compressed and 40.1 KB unpacked to the package and about 40 KB to a production install; install wall/RSS changes are within warm-cache noise. Static inspection itself is cheap relative to starting a dev server or running a build, but it inspects a smaller scope. These observations do not promise a universal 1-second or 0-MB budget, and source KB is not converted to install MB.
