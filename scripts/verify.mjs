#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "dist", "cli.js");
const FIXTURE = join(ROOT, "fixtures", "mini-app");
const NPM = process.platform === "win32" ? "npm.cmd" : "npm";

let failed = 0;

function check(name, ok, detail = "") {
  console.log(`${ok ? "✔" : "✘"} ${name}`);
  if (ok) return;
  failed += 1;
  if (detail) {
    const tail = detail.trim().split("\n").slice(-15).join("\n");
    console.log(tail.replace(/^/gm, "    "));
  }
}

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: "utf8",
    timeout: 240_000,
    ...options,
  });
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

async function runCli(args, cwd) {
  const port = await freePort();
  return run(process.execPath, [CLI, "--fast", ...args, "--port", String(port)], { cwd });
}

async function main() {
  const build = run(NPM, ["run", "build"], { cwd: ROOT });
  check("build", build.status === 0, build.stderr || build.stdout);

  const testDir = join(ROOT, "test");
  const testFiles = (await readdir(testDir))
    .filter((name) => name.endsWith(".test.js"))
    .map((name) => join(testDir, name));
  const tests = run(process.execPath, ["--test", ...testFiles], { cwd: ROOT });
  const passed = (tests.stdout.match(/^ℹ pass (\d+)$/m) ?? [])[1] ?? "?";
  check(`unit tests (${passed})`, tests.status === 0, tests.stdout || tests.stderr);

  if (!existsSync(join(FIXTURE, "node_modules"))) {
    const install = run(NPM, ["ci"], { cwd: FIXTURE });
    check("install fixture dependencies", install.status === 0, install.stderr || install.stdout);
    if (install.status !== 0) {
      console.log(`\n${failed} check(s) failed.`);
      process.exit(1);
    }
  }

  const work = await mkdtemp(join(ROOT, ".verify-"));
  try {
    for (const entry of ["app", "lib", "package.json", "tsconfig.json", "next-env.d.ts"]) {
      if (existsSync(join(FIXTURE, entry))) {
        await cp(join(FIXTURE, entry), join(work, entry), { recursive: true });
      }
    }
    await symlink(join(FIXTURE, "node_modules"), join(work, "node_modules"), "dir");

    const ko = await runCli(["--json", "--lang", "ko"], work);
    let report = null;
    try {
      report = JSON.parse(ko.stdout);
    } catch {
      // reported below
    }
    const leak = report?.diff?.routes?.find((route) => route.path === "/api/leak");
    check("real app: an open API exits 1", ko.status === 1, ko.stderr || ko.stdout);
    check("real app: the open API is critical", leak?.severity === "critical", ko.stdout);
    check(
      "real app: detail follows --lang ko",
      /데이터가 그대로/.test(leak?.detail ?? ""),
      ko.stdout,
    );

    const ja = await runCli(["--lang", "ja"], work);
    check(
      "real app: report follows --lang ja",
      ja.status === 1 && ja.stdout.includes("デプロイを止めてください"),
      ja.stderr || ja.stdout,
    );

    await writeFile(
      join(work, "kkomkkom.config.json"),
      JSON.stringify({ ignoreRoutes: ["/api/leak", "/api/orders/*"] }),
    );

    const warn = await runCli(["--lang", "es"], work);
    check(
      "warnings alone exit 0",
      warn.status === 0 && warn.stdout.includes("Revisa antes de desplegar"),
      warn.stderr || warn.stdout,
    );

    const strict = await runCli(["--lang", "es", "--strict"], work);
    check(
      "--strict turns warnings into exit 1",
      strict.status === 1 && strict.stdout.includes("Revisa antes de desplegar"),
      strict.stderr || strict.stdout,
    );
  } finally {
    await rm(work, { recursive: true, force: true });
  }

  const total = failed === 0 ? "all checks passed" : `${failed} check(s) failed`;
  console.log(`\n${total}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
