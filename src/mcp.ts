#!/usr/bin/env node
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { findProjectRoot } from "./discover.js";
import { KkomkkomError } from "./errors.js";
import { resolveLang, t } from "./i18n.js";
import { renderReport } from "./report.js";
import { runCheck } from "./run.js";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };

const TOOL = {
  name: "kkomkkom",
  description:
    "Check a Next.js app for API routes reachable without auth and pages that got much heavier. Use it before committing.",
  inputSchema: {
    type: "object",
    properties: {
      projectPath: { type: "string", description: "Next.js project path (default: current folder)" },
      fast: { type: "boolean", description: "Auth check only, skip the build" },
      strict: { type: "boolean", description: "Treat warnings as failures" },
      reuse: { type: "boolean", description: "Use a Next server already running on the port" },
      lang: { type: "string", description: "Report language: en, ko, ja, zh, es" },
    },
  },
};

function send(message: unknown): void {
  process.stdout.write(JSON.stringify(message) + "\n");
}

async function callTool(args: {
  projectPath?: string;
  fast?: boolean;
  strict?: boolean;
  reuse?: boolean;
  lang?: string;
}) {
  const cwd = args.projectPath ? resolve(args.projectPath) : process.cwd();
  const root = await findProjectRoot(cwd);
  const lang = resolveLang(args.lang);
  const result = await runCheck({
    root,
    fast: args.fast === true,
    strict: args.strict === true,
    reuse: args.reuse === true,
  });
  const text = renderReport(result.diff, {
    lang,
    color: false,
    buildFailed: result.buildFailed,
    buildTail: result.buildTail,
  });
  return { content: [{ type: "text", text }], isError: result.exitCode !== 0 };
}

const rl = createInterface({ input: process.stdin });

rl.on("line", async (line) => {
  if (!line.trim()) return;

  let message: { id?: number | string; method?: string; params?: Record<string, unknown> };
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }

  const { id, method, params } = message;
  if (method === "notifications/initialized") return;

  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: (params?.protocolVersion as string) ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "kkomkkom", version: pkg.version },
      },
    });
    return;
  }

  if (method === "ping") {
    send({ jsonrpc: "2.0", id, result: {} });
    return;
  }

  if (method === "tools/list") {
    send({ jsonrpc: "2.0", id, result: { tools: [TOOL] } });
    return;
  }

  if (method === "tools/call" && params?.name === TOOL.name) {
    try {
      const result = await callTool(
        (params.arguments as {
          projectPath?: string;
          fast?: boolean;
          strict?: boolean;
          reuse?: boolean;
          lang?: string;
        }) ?? {},
      );
      send({ jsonrpc: "2.0", id, result });
    } catch (error) {
      const lang = resolveLang((params.arguments as { lang?: string } | undefined)?.lang);
      const text =
        error instanceof KkomkkomError
          ? t(lang, error.key, error.vars)
          : error instanceof Error
            ? error.message
            : String(error);
      send({
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text }],
          isError: true,
        },
      });
    }
    return;
  }

  if (id !== undefined) {
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
  }
});
