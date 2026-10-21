import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverRoutes, findProjectRoot } from "../dist/discover.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "kkomkkom-"));
  await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { next: "16.0.0" } }));
  const files = {
    "app/api/users/route.ts": "export async function GET() { return Response.json([]) }",
    "app/api/orders/[id]/route.ts": "export async function GET() { return Response.json({}) }",
    "app/(shop)/checkout/page.tsx": "export default function Page() { return null }",
    "app/page.tsx": "export default function Page() { return null }",
    "pages/api/health.ts": "export default function handler() {}",
    "pages/index.tsx": "export default function Page() { return null }",
    "pages/_app.tsx": "export default function App() { return null }",
  };
  for (const [path, body] of Object.entries(files)) {
    const full = join(root, path);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, body);
  }
  return root;
}

test("findProjectRoot finds the folder with next dependency", async () => {
  const root = await fixture();
  const nested = join(root, "app", "api");
  assert.equal(await findProjectRoot(nested), root);
  await rm(root, { recursive: true, force: true });
});

test("discoverRoutes maps app and pages routes", async () => {
  const root = await fixture();
  const routes = await discoverRoutes(root);
  const paths = routes.map((route) => `${route.kind}:${route.path}`);

  assert.ok(paths.includes("api:/api/users"));
  assert.ok(paths.includes("page:/checkout"));
  assert.ok(paths.includes("page:/"));
  assert.ok(paths.includes("api:/api/health"));
  assert.ok(!paths.some((path) => path.includes("_app")));
  await rm(root, { recursive: true, force: true });
});

test("discoverRoutes supports src/app and src/pages", async () => {
  const root = await mkdtemp(join(tmpdir(), "kkomkkom-src-"));
  await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { next: "16.0.0" } }));
  const files = {
    "src/app/api/leak/route.ts": "export async function GET() { return Response.json({}) }",
    "src/app/dashboard/page.tsx": "export default function Page() { return null }",
    "src/pages/api/legacy.ts": "export default function handler() {}",
    "src/pages/index.tsx": "export default function Page() { return null }",
  };
  for (const [path, body] of Object.entries(files)) {
    const full = join(root, path);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, body);
  }

  const paths = (await discoverRoutes(root)).map((route) => `${route.kind}:${route.path}`);
  assert.ok(paths.includes("api:/api/leak"));
  assert.ok(paths.includes("page:/dashboard"));
  assert.ok(paths.includes("api:/api/legacy"));
  assert.ok(paths.includes("page:/"));
  await rm(root, { recursive: true, force: true });
});

test("discoverRoutes marks dynamic routes", async () => {
  const root = await fixture();
  const routes = await discoverRoutes(root);
  const dynamic = routes.find((route) => route.path === "/api/orders/[id]");
  assert.ok(dynamic);
  assert.equal(dynamic.dynamic, true);
  assert.match(dynamic.source, /GET/);
  await rm(root, { recursive: true, force: true });
});
