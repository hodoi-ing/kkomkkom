import { test } from "node:test";
import assert from "node:assert/strict";
import { LANGS, MESSAGE_KEYS, resolveLang, t } from "../dist/i18n.js";

function withCleanEnv(run) {
  const keys = ["KKOMKKOM_LANG", "LC_ALL", "LANG"];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  try {
    return run();
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

test("resolveLang prefers the flag over the environment", () => {
  withCleanEnv(() => {
    process.env.LC_ALL = "ja_JP.UTF-8";
    assert.equal(resolveLang("ko"), "ko");
    assert.equal(resolveLang("ko-KR"), "ko");
    assert.equal(resolveLang(undefined), "ja");
  });
});

test("resolveLang falls back to KKOMKKOM_LANG, then en", () => {
  withCleanEnv(() => {
    process.env.LC_ALL = "C.UTF-8";
    process.env.KKOMKKOM_LANG = "es";
    assert.equal(resolveLang(), "es");

    delete process.env.KKOMKKOM_LANG;
    assert.equal(resolveLang(), "en");
  });
});

test("t fills placeholders", () => {
  assert.equal(t("ko", "stopBanner", { count: 3 }), "⛔ 배포를 멈추세요 — 문제 3개가 있습니다.");
  assert.equal(t("en", "restSame", { count: 2 }), "The other 2 match the last run.");
  assert.equal(t("ja", "newExposedTitle", { count: 1 }), "🔴 新たに開いた扉 1件");
});

test("every language has every message with no unfilled placeholders", () => {
  const vars = { count: 1, status: 200, port: 3100, log: "log", lang: "xx", provider: "claude", location: "?", file: ".env", line: 1, key: "NEXT_PUBLIC_TOKEN", path: "/api/x", seconds: 8, reason: "exit 1", field: "port" };
  for (const lang of LANGS) {
    for (const key of MESSAGE_KEYS) {
      const text = t(lang, key, vars);
      assert.ok(text.length > 0, `${lang}/${key} is empty`);
      assert.ok(!text.includes("{"), `${lang}/${key} left a placeholder: ${text}`);
    }
  }
});
