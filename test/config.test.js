import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../dist/config.js";

async function configRoot(t, value) {
  const root = await mkdtemp(join(tmpdir(), "kkomkkom-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  if (value !== undefined) {
    await writeFile(
      join(root, "kkomkkom.config.json"),
      typeof value === "string" ? value : JSON.stringify(value),
    );
  }
  return root;
}

async function rejectsField(root, field) {
  await assert.rejects(
    () => loadConfig(root),
    (error) => {
      assert.equal(error.key, "errConfigField");
      assert.equal(error.vars.field, field);
      return true;
    },
  );
}

test("missing config returns isolated defaults", async (t) => {
  const root = await configRoot(t);
  const first = await loadConfig(root);
  assert.deepEqual(first, {
    ignoreRoutes: [],
    sampleParams: {},
    port: 3100,
    thresholds: { jsPercent: 15, jsBytes: 30000 },
    routePolicies: {},
  });
  first.ignoreRoutes.push("/api/x");
  first.thresholds.jsBytes = 1;
  const second = await loadConfig(root);
  assert.deepEqual(second.ignoreRoutes, []);
  assert.equal(second.thresholds.jsBytes, 30000);
});

test("valid config is merged with defaults", async (t) => {
  const root = await configRoot(t, {
    ignoreRoutes: ["/api/health"],
    sampleParams: { "/api/orders/[id]": { id: "42" } },
    port: 3210,
    thresholds: { jsPercent: 20 },
    routePolicies: {
      "/api/health": { GET: "public" },
      "/api/orders/[id]": { GET: "protected", POST: "protected" },
    },
  });
  assert.deepEqual(await loadConfig(root), {
    ignoreRoutes: ["/api/health"],
    sampleParams: { "/api/orders/[id]": { id: "42" } },
    port: 3210,
    thresholds: { jsPercent: 20, jsBytes: 30000 },
    routePolicies: {
      "/api/health": { GET: "public" },
      "/api/orders/[id]": { GET: "protected", POST: "protected" },
    },
  });
});

test("invalid JSON and non-object roots are config errors", async (t) => {
  const bad = await configRoot(t, "{bad");
  await assert.rejects(() => loadConfig(bad), (error) => error.key === "errConfig");
  for (const value of ["null", "[]", '"string"']) {
    const root = await configRoot(t, value);
    await assert.rejects(() => loadConfig(root), (error) => error.key === "errConfig");
  }
});

test("config read failures other than ENOENT are sanitized errors", async (t) => {
  const dirRoot = await mkdtemp(join(tmpdir(), "kkomkkom-config-"));
  t.after(() => rm(dirRoot, { recursive: true, force: true }));
  await mkdir(join(dirRoot, "kkomkkom.config.json"));
  await assert.rejects(
    () => loadConfig(dirRoot),
    (error) => {
      assert.equal(error.key, "errConfigRead");
      assert.deepEqual(error.vars, {});
      return true;
    },
  );

  if (process.getuid?.() !== 0) {
    const fileRoot = await mkdtemp(join(tmpdir(), "kkomkkom-config-"));
    t.after(() => rm(fileRoot, { recursive: true, force: true }));
    const file = join(fileRoot, "kkomkkom.config.json");
    await writeFile(file, "{}");
    await chmod(file, 0o000);
    await assert.rejects(
      () => loadConfig(fileRoot),
      (error) => error.key === "errConfigRead",
    );
  }
});

test("port must be an integer in 1..65535", async (t) => {
  for (const port of [0, -1, 65536, 3.14, "3100"]) {
    await rejectsField(await configRoot(t, { port }), "port");
  }
});

test("ignoreRoutes must be a non-empty string array", async (t) => {
  await rejectsField(await configRoot(t, { ignoreRoutes: "/api/x" }), "ignoreRoutes");
  await rejectsField(await configRoot(t, { ignoreRoutes: null }), "ignoreRoutes");
  await rejectsField(await configRoot(t, { ignoreRoutes: [1] }), "ignoreRoutes[0]");
  await rejectsField(await configRoot(t, { ignoreRoutes: [""] }), "ignoreRoutes[0]");
});

test("sampleParams must map routes to string values", async (t) => {
  for (const value of [[], null, "/api/x"]) {
    await rejectsField(await configRoot(t, { sampleParams: value }), "sampleParams");
  }
  await rejectsField(
    await configRoot(t, { sampleParams: { "/api/x": null } }),
    'sampleParams["/api/x"]',
  );
  await rejectsField(
    await configRoot(t, { sampleParams: { "/api/x": { id: 1 } } }),
    'sampleParams["/api/x"].id',
  );
});

test("thresholds must be finite non-negative numbers", async (t) => {
  for (const [value, field] of [
    [null, "thresholds"],
    [[], "thresholds"],
    [-1, "thresholds"],
    ["15", "thresholds"],
    [{ jsPercent: -1 }, "thresholds.jsPercent"],
    [{ jsBytes: "1" }, "thresholds.jsBytes"],
  ]) {
    await rejectsField(await configRoot(t, { thresholds: value }), field);
  }
});

test("routePolicies accepts only exact templates, known methods and known policies", async (t) => {
  await rejectsField(await configRoot(t, { routePolicies: [] }), "routePolicies");
  await rejectsField(await configRoot(t, { routePolicies: null }), "routePolicies");
  await rejectsField(
    await configRoot(t, { routePolicies: { "/api/x": { post: "public" } } }),
    'routePolicies["/api/x"].post',
  );
  await rejectsField(
    await configRoot(t, { routePolicies: { "/api/x": { POST: "private" } } }),
    'routePolicies["/api/x"].POST',
  );
  await rejectsField(
    await configRoot(t, { routePolicies: { "/api/x": "public" } }),
    "routePolicies[\"/api/x\"]",
  );
  await rejectsField(
    await configRoot(t, { routePolicies: { "api/x": { GET: "public" } } }),
    "routePolicies",
  );
});
