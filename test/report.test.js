import { test } from "node:test";
import assert from "node:assert/strict";
import { renderReport } from "../dist/report.js";

const exposedDiff = {
  firstRun: false,
  routes: [
    {
      path: "/api/leak",
      from: undefined,
      to: "exposed",
      state: "new",
      detailKey: "detailExposed",
      detailVars: { status: 200 },
    },
  ],
  pages: [],
};

test("an exposed route shows the deploy-stop banner", () => {
  const out = renderReport(exposedDiff, { lang: "ko", color: false });
  assert.match(out, /배포를 멈추세요/);
  assert.match(out, /\/api\/leak/);
  assert.match(out, /로그인 없이 데이터가 그대로 나옵니다 \(200\)/);
  assert.ok(!out.includes("\u001b["), "color codes must be off");
});

test("the report follows the requested language", () => {
  assert.match(renderReport(exposedDiff, { lang: "ja", color: false }), /デプロイを止めてください/);
  assert.match(renderReport(exposedDiff, { lang: "zh", color: false }), /请停止部署/);
  assert.match(renderReport(exposedDiff, { lang: "es", color: false }), /Detén el despliegue/);
});

test("a clean run says it is safe to deploy", () => {
  const out = renderReport({ firstRun: false, routes: [], pages: [] }, { lang: "ko", color: false });
  assert.match(out, /검사한 범위에서 차단 문제가 없습니다/);
});

test("warnings without exposure show the warning banner, not the stop banner", () => {
  const diff = {
    firstRun: false,
    routes: [
      {
        path: "/api/health",
        from: undefined,
        to: "check",
        state: "new",
        detailKey: "detailCheck",
        detailVars: { status: 200 },
      },
    ],
    pages: [],
  };
  const out = renderReport(diff, { lang: "en", color: false });
  assert.match(out, /Check before deploy/);
  assert.doesNotMatch(out, /Stop the deploy/);
});

test("a warning that was already there is still shown", () => {
  const diff = {
    firstRun: false,
    routes: [
      {
        path: "/api/health",
        from: "check",
        to: "check",
        state: "same",
        detailKey: "detailCheck",
        detailVars: { status: 200 },
      },
    ],
    pages: [],
  };
  const out = renderReport(diff, { lang: "en", color: false });
  assert.match(out, /Check before deploy — 1 warning/);
  assert.match(out, /\/api\/health/);
  assert.doesNotMatch(out, /No blocking problems in the checked scope/);
});

test("new and existing exposed routes are both listed", () => {
  const diff = {
    firstRun: false,
    routes: [
      {
        path: "/api/a",
        from: "exposed",
        to: "exposed",
        state: "same",
        detailKey: "detailExposed",
        detailVars: { status: 200 },
      },
      {
        path: "/api/b",
        from: undefined,
        to: "exposed",
        state: "new",
        detailKey: "detailExposed",
        detailVars: { status: 200 },
      },
    ],
    pages: [],
  };
  const out = renderReport(diff, { lang: "en", color: false });
  assert.match(out, /Newly open doors: 1/);
  assert.match(out, /Open doors: 1/);
  assert.match(out, /\/api\/a/);
  assert.match(out, /\/api\/b/);
});

test("a failed build never says it is safe to deploy", () => {
  const out = renderReport(
    { firstRun: false, routes: [], pages: [] },
    { lang: "en", color: false, buildFailed: true, buildTail: "Error: boom" },
  );
  assert.match(out, /The build failed/);
  assert.doesNotMatch(out, /No blocking problems in the checked scope/);
});

test("a critical project check stops the deploy", () => {
  const out = renderReport(
    { firstRun: false, routes: [], pages: [] },
    {
      lang: "ko",
      color: false,
      extras: [
        {
          id: "env-tracked:.env",
          severity: "critical",
          messageKey: "extraEnvTracked",
          messageVars: { file: ".env" },
        },
      ],
    },
  );
  assert.match(out, /배포를 멈추세요/);
  assert.match(out, /프로젝트 점검 1개/);
  assert.match(out, /\.env이\(가\) git에 올라가 있습니다/);
  assert.doesNotMatch(out, /검사한 범위에서 차단 문제가 없습니다/);
});

test("a warning project check uses the warning banner", () => {
  const out = renderReport(
    { firstRun: false, routes: [], pages: [] },
    {
      lang: "en",
      color: false,
      extras: [
        {
          id: "write-no-auth:/api/orders",
          severity: "warning",
          messageKey: "extraWriteNoAuth",
          messageVars: { path: "/api/orders", method: "POST" },
        },
      ],
    },
  );
  assert.match(out, /Check before deploy — 1 warning/);
  assert.match(out, /\/api\/orders \(POST\) handles writes without an auth check/);
  assert.doesNotMatch(out, /Stop the deploy/);
});

test("an info project check is shown without blocking", () => {
  const out = renderReport(
    { firstRun: false, routes: [], pages: [] },
    {
      lang: "en",
      color: false,
      extras: [
        {
          id: "page-timeout:/slow",
          severity: "info",
          messageKey: "extraPageTimeout",
          messageVars: { path: "/slow", seconds: 8 },
        },
      ],
    },
  );
  assert.match(out, /No blocking problems in the checked scope/);
  assert.match(out, /\/slow could not be checked \(8s timeout or connection failed\)/);
});

test("an incomplete or empty scope never shows the pass banner", () => {
  const checks = (states) => ({
    status: states.includes("checked") ? "incomplete" : "empty",
    checks: [],
    counts: { checked: 0, "static-only": 0, ignored: 0, skipped: 0, failed: 0, unsupported: 0 },
  });
  const incomplete = renderReport(
    { firstRun: false, routes: [], pages: [] },
    { lang: "en", color: false, coverage: checks(["checked", "ignored"]) },
  );
  assert.doesNotMatch(incomplete, /No blocking problems in the checked scope/);
  assert.match(incomplete, /Check scope is incomplete/);

  const empty = renderReport(
    { firstRun: false, routes: [], pages: [] },
    { lang: "ko", color: false, coverage: checks(["ignored"]) },
  );
  assert.doesNotMatch(empty, /검사한 범위에서 차단 문제가 없습니다/);
  assert.match(empty, /유의미한 검사를 하나도 하지 못했습니다/);
});
