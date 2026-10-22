#!/usr/bin/env node
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { redactSecrets } from "./audit.js";
import { findProjectRoot } from "./discover.js";
import { KkomkkomError } from "./errors.js";
import { isLang, resolveLang, t, type Lang } from "./i18n.js";
import { renderReport } from "./report.js";
import { runCheck } from "./run.js";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };

const TOOL = {
  name: "kkomkkom",
  description:
    "Check a Next.js app for API routes reachable without auth, exposed secrets, page errors, write APIs without auth, and pages that got much heavier. Use it before committing.",
  inputSchema: {
    type: "object",
    properties: {
      projectPath: { type: "string", description: "Next.js project path (default: current folder)" },
      fast: { type: "boolean", description: "Auth check only, skip the build" },
      strict: { type: "boolean", description: "Treat warnings as failures" },
      reuse: { type: "boolean", description: "Use a Next server already running on the port (project identity is not verified)" },
      lang: { type: "string", description: "Report language: en, ko, ja, zh, es" },
    },
  },
};

interface ToolArgs {
  projectPath?: string;
  fast?: boolean;
  strict?: boolean;
  reuse?: boolean;
  lang?: string;
}

type JsonRpcId = string | number | null;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function send(message: unknown): void {
  process.stdout.write(JSON.stringify(message) + "\n");
}

function sendError(id: JsonRpcId | undefined, code: number, message: string): void {
  if (id === undefined) return;
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function invalid(field: string): never {
  throw new KkomkkomError("errMcpArgs", { field });
}

function validateArgs(value: unknown): ToolArgs {
  if (value === undefined) return {};
  if (!isPlainObject(value)) invalid("arguments");

  const args: ToolArgs = {};
  if ("projectPath" in value) {
    if (typeof value.projectPath !== "string" || value.projectPath.trim() === "") invalid("projectPath");
    args.projectPath = value.projectPath;
  }
  for (const key of ["fast", "strict", "reuse"] as const) {
    if (key in value) {
      if (typeof value[key] !== "boolean") invalid(key);
      args[key] = value[key];
    }
  }
  if ("lang" in value) {
    if (typeof value.lang !== "string" || !isLang(value.lang.toLowerCase().split(/[._-]/)[0])) {
      invalid("lang");
    }
    args.lang = value.lang;
  }
  return args;
}

function cwdOf(value: unknown): string {
  if (isPlainObject(value) && typeof value.projectPath === "string") {
    return resolve(value.projectPath);
  }
  return process.cwd();
}

async function callTool(args: ToolArgs) {
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
    extras: result.extras,
    coverage: result.coverage,
  });
  return {
    content: [{ type: "text", text }],
    structuredContent: {
      schemaVersion: result.schemaVersion,
      exitCode: result.exitCode,
      buildFailed: result.buildFailed,
      coverage: result.coverage,
      diff: result.diff,
      extra: result.extras,
    },
    isError: result.exitCode !== 0,
  };
}

async function sendToolError(
  id: JsonRpcId | undefined,
  error: unknown,
  lang: Lang,
  cwd: string,
): Promise<void> {
  let text: string;
  if (error instanceof KkomkkomError) {
    text = t(lang, error.key, error.vars);
  } else {
    text = error instanceof Error ? error.message : String(error);
  }
  text = await redactSecrets(cwd, text).catch(() => text);
  send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }], isError: true } });
}

async function handleLine(line: string): Promise<void> {
  if (!line.trim()) return;

  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    sendError(null, -32700, "Parse error");
    return;
  }
  if (!isPlainObject(message)) {
    sendError(null, -32600, "Invalid Request");
    return;
  }

  const rawId = message.id;
  if (rawId !== undefined && rawId !== null && typeof rawId !== "string" && typeof rawId !== "number") {
    sendError(null, -32600, "Invalid Request");
    return;
  }
  const id = rawId as JsonRpcId | undefined;
  const method = message.method;
  if (typeof method !== "string") {
    sendError(id, -32600, "Invalid Request");
    return;
  }
  const params = message.params;

  // JSON-RPC notifications never get a response and are not executed here.
  if (id === undefined) return;
  if (method === "notifications/initialized") return;

  if (method === "initialize") {
    const protocolVersion = isPlainObject(params) && typeof params.protocolVersion === "string"
      ? params.protocolVersion
      : "2024-11-05";
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion,
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

  if (method === "tools/call") {
    if (!isPlainObject(params) || typeof params.name !== "string") {
      sendError(id, -32602, "Invalid params");
      return;
    }
    if (params.name !== TOOL.name) {
      sendError(id, -32602, "Invalid params");
      return;
    }
    if (params.arguments !== undefined && !isPlainObject(params.arguments)) {
      await sendToolError(id, new KkomkkomError("errMcpArgs", { field: "arguments" }), resolveLang(), cwdOf(params.arguments));
      return;
    }

    let args: ToolArgs;
    try {
      args = validateArgs(params.arguments);
    } catch (error) {
      await sendToolError(id, error, resolveLang(), cwdOf(params.arguments));
      return;
    }

    try {
      const result = await callTool(args);
      send({ jsonrpc: "2.0", id, result });
    } catch (error) {
      await sendToolError(id, error, resolveLang(args.lang), cwdOf(args));
    }
    return;
  }

  sendError(id, -32601, "Method not found");
}

const rl = createInterface({ input: process.stdin });
let queue: Promise<void> = Promise.resolve();
rl.on("line", (line) => {
  // One inspection at a time: concurrent runs would race over dev-server ports
  // and SIGINT ownership in this single process.
  queue = queue
    .then(() => handleLine(line))
    .catch(() => sendError(null, -32603, "Internal error"));
});
