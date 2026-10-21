import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBaseline, diffBaseline, loadBaseline, saveBaseline } from "../dist/baseline.js";

const thresholds = { jsPercent: 15, jsBytes: 30000 };

function finding(path, verdict) {
  return { path, verdict, detailKey: "detailUnknown" };
}

test("first run marks every route as new", () => {
  const diff = diffBaseline(null, [finding("/api/a", "exposed")], {}, thresholds);
  assert.equal(diff.firstRun, true);
  assert.equal(diff.routes[0].state, "new");
});

test("exposed to locked becomes fixed", () => {
  const previous = buildBaseline([finding("/api/a", "exposed")], {});
  const diff = diffBaseline(previous, [finding("/api/a", "locked")], {}, thresholds);
  assert.equal(diff.routes[0].state, "fixed");
});

test("unknown route appears as new", () => {
  const previous = buildBaseline([finding("/api/a", "locked")], {});
  const diff = diffBaseline(previous, [finding("/api/b", "check")], {}, thresholds);
  assert.equal(diff.routes[0].state, "new");
});

test("page weight change follows thresholds", () => {
  const previous = buildBaseline([], { "/checkout": { firstLoadJs: 100_000 } });
  const diff = diffBaseline(previous, [], { "/checkout": { firstLoadJs: 140_000 } }, thresholds);
  assert.equal(diff.pages[0].heavy, true);
  assert.equal(diff.pages[0].deltaBytes, 40_000);
});

test("small page weight change is not heavy", () => {
  const previous = buildBaseline([], { "/checkout": { firstLoadJs: 100_000 } });
  const diff = diffBaseline(previous, [], { "/checkout": { firstLoadJs: 120_000 } }, thresholds);
  assert.equal(diff.pages[0].heavy, false);
});

test("save and load round trip", async () => {
  const root = await mkdtemp(join(tmpdir(), "kkomkkom-base-"));
  const baseline = buildBaseline([finding("/api/a", "locked")], { "/": { firstLoadJs: 1000 } });
  await saveBaseline(root, baseline);
  const loaded = await loadBaseline(root);
  assert.equal(loaded.routes["/api/a"].verdict, "locked");
  assert.equal(loaded.pages["/"].firstLoadJs, 1000);
  await rm(root, { recursive: true, force: true });
});

test("broken baseline is backed up and ignored", async () => {
  const root = await mkdtemp(join(tmpdir(), "kkomkkom-base-"));
  await mkdir(join(root, ".kkomkkom"), { recursive: true });
  await writeFile(join(root, ".kkomkkom", "baseline.json"), "{not json");
  const loaded = await loadBaseline(root);
  assert.equal(loaded, null);
  const backup = await readFile(join(root, ".kkomkkom", "baseline.json.bak"), "utf8");
  assert.equal(backup, "{not json");
  await rm(root, { recursive: true, force: true });
});
