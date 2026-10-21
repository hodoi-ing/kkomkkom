import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { measurePages, parseFirstLoadJs } from "../dist/build.js";

const APP_ROUTER_OUTPUT = `
Route (app)                                 Size  First Load JS
┌ ○ /                                    1.24 kB         120 kB
├ ○ /_not-found                            987 B         101 kB
├ ƒ /api/users                               0 B             0 B
├ ƒ /api/orders/[id]                         0 B             0 B
├ ○ /checkout                             5.12 kB         180 kB
└ ○ /dashboard                             2.00 kB         140 kB
+ First Load JS shared by all             99.9 kB
`;

const PAGES_ROUTER_OUTPUT = `
Route (pages)                              Size  First Load JS
┌ ○ /                                      1.2 kB         110 kB
├   /_app                                     0 B          99 kB
├ ƒ /api/health                               0 B            0 B
└ ○ /pricing                               3.4 kB         130 kB
+ First Load JS shared by all               99 kB
`;

test("parses app router build output", () => {
  const pages = parseFirstLoadJs(APP_ROUTER_OUTPUT);
  assert.equal(pages["/"].firstLoadJs, 120_000);
  assert.equal(pages["/checkout"].firstLoadJs, 180_000);
  assert.equal(pages["/dashboard"].firstLoadJs, 140_000);
  assert.equal(pages["/api/users"], undefined);
});

test("parses pages router build output", () => {
  const pages = parseFirstLoadJs(PAGES_ROUTER_OUTPUT);
  assert.equal(pages["/"].firstLoadJs, 110_000);
  assert.equal(pages["/pricing"].firstLoadJs, 130_000);
  assert.equal(pages["/api/health"], undefined);
});

test("returns empty map for unreadable output", () => {
  assert.deepEqual(parseFirstLoadJs("some unrelated log"), {});
});

test("measurePages sums shared and route-specific chunks", async () => {
  const root = await mkdtemp(join(tmpdir(), "kkomkkom-build-"));
  await mkdir(join(root, ".next", "static", "chunks"), { recursive: true });
  await mkdir(join(root, ".next", "server", "app", "checkout"), { recursive: true });
  await writeFile(join(root, ".next", "static", "chunks", "shared.js"), "x".repeat(1000));
  await writeFile(join(root, ".next", "static", "chunks", "route.js"), "x".repeat(500));
  await writeFile(
    join(root, ".next", "build-manifest.json"),
    JSON.stringify({ rootMainFiles: ["static/chunks/shared.js"], polyfillFiles: [] }),
  );
  await writeFile(
    join(root, ".next", "server", "app", "checkout", "page_client-reference-manifest.js"),
    'globalThis.x = ["/_next/static/chunks/route.js"];',
  );

  const pages = await measurePages(root);
  assert.equal(pages["/checkout"].firstLoadJs, 1500);
  await rm(root, { recursive: true, force: true });
});
