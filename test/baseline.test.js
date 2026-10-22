import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, utimes, writeFile, chmod, rm } from "node:fs/promises";
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

test("page weight change follows thresholds when both methods match", () => {
  const previous = buildBaseline([], { "/checkout": { firstLoadJs: 100_000, method: "manifest-file" } });
  const diff = diffBaseline(
    previous,
    [],
    { "/checkout": { firstLoadJs: 140_000, method: "manifest-file" } },
    thresholds,
  );
  assert.equal(diff.pages[0].heavy, true);
  assert.equal(diff.pages[0].deltaBytes, 40_000);
});

test("small page weight change is not heavy", () => {
  const previous = buildBaseline([], { "/checkout": { firstLoadJs: 100_000, method: "manifest-file" } });
  const diff = diffBaseline(
    previous,
    [],
    { "/checkout": { firstLoadJs: 120_000, method: "manifest-file" } },
    thresholds,
  );
  assert.equal(diff.pages[0].heavy, false);
});

test("save and load round trip", async () => {
  const root = await mkdtemp(join(tmpdir(), "kkomkkom-base-"));
  const baseline = buildBaseline([finding("/api/a", "locked")], { "/": { firstLoadJs: 1000, method: "manifest-file" } });
  await saveBaseline(root, baseline);
  const loaded = await loadBaseline(root);
  assert.equal(loaded.routes["/api/a"].verdict, "locked");
  assert.equal(loaded.pages["/"].firstLoadJs, 1000);
  assert.equal(loaded.pages["/"].method, "manifest-file");
  await rm(root, { recursive: true, force: true });
});

test("a legacy baseline without measurement metadata still loads but is never compared", async () => {
  const root = await mkdtemp(join(tmpdir(), "kkomkkom-base-"));
  await mkdir(join(root, ".kkomkkom"), { recursive: true });
  await writeFile(join(root, ".kkomkkom", "baseline.json"), JSON.stringify({
    version: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    routes: { "/api/a": { verdict: "locked" } },
    pages: { "/": { firstLoadJs: 1000 } },
  }));

  const loaded = await loadBaseline(root);
  assert.equal(loaded.pages["/"].method, undefined);
  const diff = diffBaseline(loaded, [], { "/": { firstLoadJs: 1500, method: "manifest-file" } }, thresholds);
  assert.equal(diff.pages[0].comparable, false);
  assert.equal(diff.pages[0].deltaBytes, 0);
  assert.equal(diff.pages[0].heavy, false);
  assert.equal(diff.pages[0].from, 1000);
  await rm(root, { recursive: true, force: true });
});

test("two weight measurements without a method are not compared", () => {
  const previous = buildBaseline([], { "/": { firstLoadJs: 1000 } });
  const diff = diffBaseline(previous, [], { "/": { firstLoadJs: 2000 } }, thresholds);
  assert.equal(diff.pages[0].comparable, false);
  assert.equal(diff.pages[0].deltaBytes, 0);
  assert.equal(diff.pages[0].heavy, false);
});

test("measurements from different methods are not compared directly", () => {
  const previous = buildBaseline([], { "/": { firstLoadJs: 100_000, method: "next-output" } });
  const diff = diffBaseline(previous, [], { "/": { firstLoadJs: 140_000, method: "manifest-file" } }, thresholds);
  assert.equal(diff.pages[0].comparable, false);
  assert.equal(diff.pages[0].deltaBytes, 0);
  assert.equal(diff.pages[0].heavy, false);
});

test("a corrupt baseline is reported and preserved in place", async () => {
  const root = await mkdtemp(join(tmpdir(), "kkomkkom-base-"));
  await mkdir(join(root, ".kkomkkom"), { recursive: true });
  const file = join(root, ".kkomkkom", "baseline.json");
  await writeFile(file, "{not json");

  await assert.rejects(
    () => loadBaseline(root),
    (error) => error.key === "errBaseline",
  );
  assert.equal(await readFile(file, "utf8"), "{not json");
  assert.equal(await readFile(`${file}.bak`, "utf8").catch(() => null), null);
  await rm(root, { recursive: true, force: true });
});

test("invalid baseline shapes, verdicts, numbers and methods are rejected unchanged", async () => {
  const cases = [
    { version: 2, createdAt: "x", routes: {}, pages: {} },
    { version: 1, createdAt: "x", routes: [], pages: {} },
    { version: 1, createdAt: "x", routes: {}, pages: null },
    { version: 1, createdAt: 5, routes: {}, pages: {} },
    { version: 1, createdAt: "x", routes: { "/api/a": { verdict: "open" } }, pages: {} },
    { version: 1, createdAt: "x", routes: { "api/a": { verdict: "locked" } }, pages: {} },
    { version: 1, createdAt: "x", routes: {}, pages: { "/": { firstLoadJs: "1000" } } },
    { version: 1, createdAt: "x", routes: {}, pages: { "/": { firstLoadJs: -1 } } },
    { version: 1, createdAt: "x", routes: {}, pages: { "/": { firstLoadJs: 1000, method: "guess" } } },
  ];
  for (const [index, value] of cases.entries()) {
    const root = await mkdtemp(join(tmpdir(), "kkomkkom-base-"));
    await mkdir(join(root, ".kkomkkom"), { recursive: true });
    const file = join(root, ".kkomkkom", "baseline.json");
    const raw = JSON.stringify(value);
    await writeFile(file, raw);
    await assert.rejects(
      () => loadBaseline(root),
      (error) => error.key === "errBaseline",
      `case ${index} must be invalid`,
    );
    assert.equal(await readFile(file, "utf8"), raw, `case ${index} must stay unchanged`);
    await rm(root, { recursive: true, force: true });
  }
});

test("missing baseline is the only absence; other read errors are explicit", async (t) => {
  const empty = await mkdtemp(join(tmpdir(), "kkomkkom-base-"));
  t.after(() => rm(empty, { recursive: true, force: true }));
  assert.equal(await loadBaseline(empty), null);

  const dirRoot = await mkdtemp(join(tmpdir(), "kkomkkom-base-"));
  t.after(() => rm(dirRoot, { recursive: true, force: true }));
  await mkdir(join(dirRoot, ".kkomkkom", "baseline.json"), { recursive: true });
  await assert.rejects(
    () => loadBaseline(dirRoot),
    (error) => error.key === "errBaselineRead",
  );

  if (process.getuid?.() !== 0 && process.platform !== "win32") {
    const fileRoot = await mkdtemp(join(tmpdir(), "kkomkkom-base-"));
    t.after(() => rm(fileRoot, { recursive: true, force: true }));
    const file = join(fileRoot, ".kkomkkom", "baseline.json");
    await mkdir(join(fileRoot, ".kkomkkom"), { recursive: true });
    await writeFile(file, "{}");
    await chmod(file, 0o000);
    await assert.rejects(
      () => loadBaseline(fileRoot),
      (error) => error.key === "errBaselineRead",
    );
  }
});

test("saving an invalid baseline changes nothing", async () => {
  const root = await mkdtemp(join(tmpdir(), "kkomkkom-base-"));
  await saveBaseline(root, buildBaseline([finding("/api/a", "locked")], {}));
  const before = await readFile(join(root, ".kkomkkom", "baseline.json"), "utf8");

  await assert.rejects(
    () => saveBaseline(root, { version: 1, createdAt: "x", routes: { "/api/a": { verdict: "open" } }, pages: {} }),
    (error) => error.key === "errBaseline",
  );
  assert.equal(await readFile(join(root, ".kkomkkom", "baseline.json"), "utf8"), before);
  await rm(root, { recursive: true, force: true });
});

test("a live or stale-looking lock is never reclaimed automatically", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "kkomkkom-base-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".kkomkkom"), { recursive: true });
  const lock = join(root, ".kkomkkom", "baseline.json.lock");
  const old = new Date(Date.now() - 3_600_000);

  for (const owner of [`${process.pid} <test>\n`, "999999 <dead>\n"]) {
    await writeFile(lock, owner);
    await utimes(lock, old, old);

    const started = Date.now();
    await assert.rejects(
      () => saveBaseline(
        root,
        buildBaseline([finding("/api/a", "locked")], {}),
        { lockTimeoutMs: 120 },
      ),
      (error) => error.key === "errBaselineLock",
    );
    assert.ok(Date.now() - started < 2000, "lock wait must be bounded");
    assert.equal(await readFile(lock, "utf8"), owner);
  }
});

test("concurrent saves leave valid JSON without lock or temporary files", async () => {
  const root = await mkdtemp(join(tmpdir(), "kkomkkom-base-"));
  const saves = Array.from({ length: 8 }, (_, index) =>
    saveBaseline(root, buildBaseline(
      [finding(`/api/${index}`, "locked")],
      { "/": { firstLoadJs: index * 1000, method: "manifest-file" } },
    )));
  await Promise.all(saves);

  const file = join(root, ".kkomkkom", "baseline.json");
  const parsed = JSON.parse(await readFile(file, "utf8"));
  assert.equal(parsed.version, 1);
  assert.equal(typeof parsed.pages["/"].firstLoadJs, "number");
  const entries = await readdir(join(root, ".kkomkkom"));
  assert.deepEqual(entries.sort(), ["baseline.json"]);
  await rm(root, { recursive: true, force: true });
});
