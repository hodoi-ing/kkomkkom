import { test } from "node:test";
import assert from "node:assert/strict";
import { severityOf } from "../dist/severity.js";

test("exposure is critical, other problems are warnings", () => {
  assert.equal(severityOf("exposed"), "critical");
  assert.equal(severityOf("check"), "warning");
  assert.equal(severityOf("error"), "warning");
  assert.equal(severityOf("locked"), "info");
  assert.equal(severityOf("public"), "info");
  assert.equal(severityOf("unknown"), "info");
});
