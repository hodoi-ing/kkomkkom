import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, hasAuthSignal, matchesGlob } from "../dist/classify.js";

test("hasAuthSignal detects common Next.js auth calls", () => {
  assert.equal(hasAuthSignal("const s = await auth()"), true);
  assert.equal(hasAuthSignal("await getServerSession(authOptions)"), true);
  assert.equal(hasAuthSignal("const jar = cookies()"), true);
  assert.equal(hasAuthSignal("return Response.json({ ok: true })"), false);
});

test("classify decides verdicts", () => {
  assert.equal(classify(401, false), "locked");
  assert.equal(classify(403, false), "locked");
  assert.equal(classify(307, false), "check");
  assert.equal(classify(200, true), "exposed");
  assert.equal(classify(200, false), "check");
  assert.equal(classify(404, false), "unknown");
  assert.equal(classify(405, false), "unknown");
  assert.equal(classify(500, true), "error");
});

test("matchesGlob supports wildcards", () => {
  assert.equal(matchesGlob("/api/webhooks/stripe", "/api/webhooks/*"), true);
  assert.equal(matchesGlob("/api/users", "/api/webhooks/*"), false);
  assert.equal(matchesGlob("/api/health", "/api/health"), true);
});
