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
  assert.match(out, /배포해도 좋습니다/);
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
  assert.doesNotMatch(out, /Safe to deploy/);
});

test("a failed build never says it is safe to deploy", () => {
  const out = renderReport(
    { firstRun: false, routes: [], pages: [] },
    { lang: "en", color: false, buildFailed: true, buildTail: "Error: boom" },
  );
  assert.match(out, /The build failed/);
  assert.doesNotMatch(out, /Safe to deploy/);
});
