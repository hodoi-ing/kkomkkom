import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/** Resolve the Next CLI installed in the project, never a downloaded npx copy. */
export function resolveNextCli(root: string): string | null {
  try {
    const require = createRequire(join(root, "package.json"));
    const pkg = require.resolve("next/package.json");
    const cli = join(dirname(pkg), "dist", "bin", "next");
    return existsSync(cli) ? cli : null;
  } catch {
    return null;
  }
}

export function nextEnv(): NodeJS.ProcessEnv {
  return { ...process.env, NEXT_TELEMETRY_DISABLED: "1" };
}
