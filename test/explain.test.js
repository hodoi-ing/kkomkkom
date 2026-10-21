import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPrompt, explain } from "../dist/explain.js";

const diff = {
  firstRun: false,
  routes: [
    { path: "/api/users", from: undefined, to: "exposed", state: "new", detail: "로그인 없이 데이터가 그대로 나옵니다 (200)" },
    { path: "/api/health", from: "locked", to: "locked", state: "same", detail: "막힘 (401)" },
  ],
  pages: [{ path: "/checkout", from: 180_000, to: 420_000, deltaBytes: 240_000, deltaPercent: 133, heavy: true }],
};

test("buildPrompt includes only problems", () => {
  const prompt = buildPrompt(diff);
  assert.match(prompt, /\/api\/users/);
  assert.match(prompt, /\/checkout/);
  assert.doesNotMatch(prompt, /\/api\/health/);
});

test("buildPrompt asks for Korean and marks guesses", () => {
  const prompt = buildPrompt(diff);
  assert.match(prompt, /한국어/);
  assert.match(prompt, /추측/);
});

test("explain falls back to an installed provider and returns its text", { skip: process.platform === "win32" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "kkomkkom-explain-"));
  const bin = join(dir, "claude");
  await writeFile(bin, "#!/bin/sh\necho '가짜 설명입니다'\n");
  await chmod(bin, 0o755);

  const originalPath = process.env.PATH;
  process.env.PATH = `${dir}:${originalPath}`;
  try {
    const result = await explain(diff);
    assert.equal(result.provider, "claude");
    assert.match(result.text, /가짜 설명/);
  } finally {
    process.env.PATH = originalPath;
    await rm(dir, { recursive: true, force: true });
  }
});
