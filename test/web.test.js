import { test } from "node:test";
import assert from "node:assert/strict";
import { analyze, knownRuleIds } from "../web/analyze.mjs";

function payload({ extra = [], routes = [], checks = [], coverage = "complete", buildFailed = false } = {}) {
  return { buildFailed, coverage: { status: coverage, checks }, diff: { routes }, extra };
}

const writeNoAuth = (path) => ({
  id: `write-no-auth:${path}:POST`,
  severity: "warning",
  message: `${path}의 POST 요청이 인증 확인 없이 쓰기를 받습니다.`,
});

test("알려진 규칙 ID가 노출된다", () => {
  const ids = knownRuleIds();
  for (const id of ["write-no-auth", "read-no-auth", "secret", "env-tracked", "page-error", "weight", "artifacts"]) {
    assert.ok(ids.includes(id), `${id} 누락`);
  }
});

test("확인된 쓰기 API는 severity가 warning이어도 S1로 올린다", () => {
  const ui = analyze(payload({ extra: [writeNoAuth("/api/entries")] }));
  assert.equal(ui.findings[0].level, "S1");
  assert.equal(ui.verdict.level, "danger");
  assert.equal(ui.counts.s1, 1);
});

test("알 수 없는 규칙은 CLI severity를 따른다", () => {
  const ui = analyze(payload({
    extra: [
      { id: "some-new-rule:/a", severity: "critical", message: "x" },
      { id: "another-rule:/b", severity: "warning", message: "y" },
      { id: "third-rule:/c", severity: "info", message: "z" },
    ],
  }));
  assert.deepEqual(ui.findings.map((f) => f.level), ["S1", "S2", "S3"]);
  assert.deepEqual(ui.unmapped.sort(), ["another-rule", "some-new-rule", "third-rule"]);
});

test("같은 규칙은 한 묶음으로 합치고 경로를 모은다", () => {
  const ui = analyze(payload({
    extra: [writeNoAuth("/api/a"), writeNoAuth("/api/b"), writeNoAuth("/api/c")],
  }));
  assert.equal(ui.next.length, 1);
  assert.equal(ui.next[0].count, 3);
  assert.equal(ui.next[0].where, "/api/a 외 2곳");
  assert.deepEqual(ui.next[0].paths, ["/api/a", "/api/b", "/api/c"]);
});

test("문제가 없고 커버리지가 완전하면 배포 가능으로 판정한다", () => {
  const ui = analyze(payload({ checks: [{ rule: "api-auth", path: "/api/x", status: "checked", reason: "none" }] }));
  assert.equal(ui.verdict.level, "ok");
  assert.equal(ui.next.length, 0);
});

test("확인하지 못한 항목이 있으면 배포 가능이라고 하지 않는다", () => {
  const ui = analyze(payload({
    coverage: "incomplete",
    routes: [{ path: "/api/x", auth: "unknown", to: "unknown" }],
    checks: [{ rule: "api-auth", path: "/api/x", status: "skipped", reason: "sample-missing" }],
  }));
  assert.equal(ui.verdict.level, "warn");
  assert.equal(ui.unknown.routes.length, 1);
  assert.equal(ui.unknown.skipped.length, 1);
  assert.equal(ui.unknown.incomplete, true);
});

test("상세 안내는 왜·순서·확인을 모두 갖는다", () => {
  const ui = analyze(payload({ extra: [writeNoAuth("/api/a")] }));
  const f = ui.findings[0];
  assert.ok(f.why.length > 20);
  assert.ok(f.steps.length >= 2);
  assert.ok(f.steps.some((s) => s.code));
  assert.ok(f.check.length > 0);
});
