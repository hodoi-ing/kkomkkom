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

The original post-feature numbers (62,545 B package, 0.21 s static, 1.74 s fresh) were observed from the 640-line first Task 2 engine. They are kept below as **prototype** observations only and are excluded from the current judgment. The current rework was measured from commit `e5e6aa3` with the same fixture, commands and warm npm cache assumptions; its raw log is [`measurement-logs/2026-10-22-artifacts-rework.txt`](measurement-logs/2026-10-22-artifacts-rework.txt).

## Package size

| Observation | Compressed tarball | Unpacked bytes | Entries | Note |
|---|---:|---:|---:|---|
| Pre-parser observation, commit `f9a21ff` (reused) | 38,691 B | 120,918 B | 41 | `npm pack --dry-run --ignore-scripts --json`; zero declared runtime dependencies at that commit |
| Issue #1 reviewed package, pre-artifact feature | 52,950 B | 171,022 B | 47 | current `dist`, one runtime dependency (`typescript`) |
| Artifact prototype, initial Task 2 engine (not current) | 62,545 B | 211,124 B | 49 | 640-line engine; excluded from the current judgment |
| Artifact rework, commit `e5e6aa3` (current) | 68,477 B | 240,309 B | 49 | AST comment recovery, indexed maps, bounded config and env masking reads |

The dry-run JSON from this npm version is a keyed object, not always an array; a parser must accept both shapes. `npm pack --ignore-scripts` was used so the recorded bytes describe the existing `dist`, not a fresh build. The prototype tarball overwrote the same-named temporary file; the pre-feature size is recorded above and in the log.

Current versus pre-feature: +15,527 B compressed (+29.3%), +69,287 B unpacked (+40.5%), +2 entries. Current versus the prototype: +5,932 B compressed, +29,185 B unpacked.

## Production install cost

Local tarball install into a fresh consumer with `--omit=dev --ignore-scripts --prefer-offline --no-audit --no-fund`:

| Measurement | Wall | Max RSS | Installed `node_modules` | Packages |
|---|---:|---:|---:|---:|
| Pre-feature | 0.53 s | 195,744 KB | 23,797,200 B | `kkomkkom` + `typescript` |
| Artifact prototype (not current) | 0.61 s | 207,312 KB | 23,837,307 B | `kkomkkom` + `typescript` |
| Artifact rework, commit `e5e6aa3` (current) | 0.56 s | 196,592 KB | 23,866,468 B | `kkomkkom` + `typescript` |

`typescript` accounts for 23,625,066 B of the installed tree. The current package's installed bytes are therefore about 241,402 B, +69,268 B (+0.29% of the whole installed tree) versus the pre-feature install. The install used a warm local npm cache. Download bytes, registry latency, cold-cache install and Windows/macOS install were **not measured**; no download size is inferred from the unpacked size.

## Fixed-fixture check cost

Commands were run as `node /home/hodol/workspace/next-preflight/dist/cli.js … --json` from a unique copy of `fixtures/mini-app`. The fixture contains a dynamic `/api/orders/[id]` route without `sampleParams`, so both normal modes report `api-auth failed/sample-missing` and `coverage.status=incomplete`; that is fixture behaviour, not a new failure.

| Mode | Command | Wall | Max RSS | Exit | Result |
|---|---|---:|---:|---:|---|
| HTTP fast (no build) | `--fast --port 3410 --json` | 2.18 s | 480,984 KB | 0 | `build` skipped/`fast`; dev server + loopback GET checks |
| Full build | `--port 3411 --json` | 6.46 s | 987,676 KB | 0 | real `next build`; manifest page weights; new `BUILD_ID` |
| Static artifacts, prototype (not current) | `--artifacts --json` | 0.21 s | 121,832 KB | 0 | 640-line engine; `coverage=complete`; 0 findings |
| Explicit fresh artifacts, prototype (not current) | `--artifacts --fresh --json` | 1.74 s | 370,696 KB | 0 | 640-line engine; warm-cache `next build`; `coverage=complete`; 0 findings |
| Static artifacts, rework `e5e6aa3` (current) | `--artifacts --json` | 0.83 s | 197,768 KB | 0 | `coverage=complete`; 0 findings; AST source and comment scans included |
| Explicit fresh artifacts, rework `e5e6aa3` (current) | `--artifacts --fresh --json` | 4.70 s | 937,884 KB | 0 | warm-cache `next build`; `coverage=complete`; 0 findings; `build checked` |

The static artifacts mode does not start a server, build, call an AI CLI or install anything. The current 0.83 s figure is the standalone inspection cost; it is not a substitute for HTTP or build coverage, and their scopes differ. The fresh run was faster than the earlier full-build run because Next's build cache was warm in the copied fixture; its wall/RSS are dominated by the Next build, not by artifact rules. The pre-feature `--fast`/full numbers used the `df10e36` `dist`; the artifact numbers used the Task 2 trees identified above. The prototype numbers are not evidence for the current engine.

## Static read I/O

The static run is not limited to `public/` and `.next/static/`. The table records every project file category the current engine may open, with the shared limits from the spec.

| Category | Paths | Condition | Limit / boundary |
|---|---|---|---|
| Served artifacts | `public/**`, `.next/static/**` | directory present | 1 MiB/file, 32 MiB total, 2,000 files; root and served-directory realpath boundary |
| Build marker | `.next/BUILD_ID` | file present | same shared file/total/count budget |
| Next config support | one `next.config.{js,mjs,cjs,ts}` | file present | same shared budget; symlink must stay in project root |
| Local inspection config | `kkomkkom.config.json` | file present | separate bounded read: 1 MiB and realpath root boundary; not counted in the 32 MiB/2,000 scan budget |
| Source graph | `app/`, `pages/`, `src/`, `lib/`, `components/`, `utils/` source extensions | directory present | same shared budget; used only to trace `use client` runtime imports |
| Masking context | root `.env*` excluding examples/samples/templates | root listing always; contents only when a file exists | same shared budget and root boundary; read failures hide exception reasons as `unconfirmed` |

`strace -f -e trace=openat` on a copy with a root `.env` and `kkomkkom.config.json` added confirmed opens of both files; the unmodified fixture has neither, so its run only lists the project root for them. Module resolution stats candidate source paths, but non-source contents (for example `.next/server`) are not read as served evidence.


## Network and cache policy

| Measurement | Network policy |
|---|---|
| `npm pack` (both) | local filesystem only; `--ignore-scripts` |
| Consumer install | local tarball plus warm npm cache; `--prefer-offline`; no intentional registry request; download bytes not instrumented |
| `--artifacts` | no HTTP, no server, no build, no install; only bounded local file reads of `public/`, `.next/static/`, `BUILD_ID`, next config, local `kkomkkom.config.json`, traced source files and root `.env*` masking context |
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

The current rework adds about 15.5 KB compressed and 69.3 KB unpacked versus the pre-feature package, and about 69 KB to a production install (+0.29% of the installed tree). Install wall/RSS changes are within warm-cache noise. Static inspection costs about 0.83 s and 198 MB RSS on this fixture after TypeScript AST parsing and source tracing, still cheaper than starting a dev server (2.18 s/481 MB) or running a build (4.70–6.46 s/938–988 MB), but it inspects a smaller scope. The earlier 0.21 s/122 MB figure belongs to the prototype and is not current evidence. These observations do not promise a universal 1-second or 0-MB budget, and source KB is not converted to install MB.
