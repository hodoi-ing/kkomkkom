#!/usr/bin/env node
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { findProjectRoot } from "./discover.js";
import { renderReport } from "./report.js";
import { runCheck } from "./run.js";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };

const TOOL = {
  name: "kkomkkom",
  description:
    "Next.js 앱의 안 잠긴 API 라우트와 무거워진 페이지를 검사합니다. 커밋 전 확인이 필요할 때 사용하세요.",
  inputSchema: {
    type: "object",
    properties: {
      projectPath: { type: "string", description: "Next.js 프로젝트 경로 (기본: 현재 폴더)" },
      fast: { type: "boolean", description: "빌드 없이 인증 검사만 실행" },
    },
  },
};

function send(message: unknown): void {
  process.stdout.write(JSON.stringify(message) + "\n");
}

async function callTool(args: { projectPath?: string; fast?: boolean }) {
  const cwd = args.projectPath ? resolve(args.projectPath) : process.cwd();
  const root = await findProjectRoot(cwd);
  const result = await runCheck({ root, fast: args.fast === true });
  const text = renderReport(result.diff, {
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
      const result = await callTool((params.arguments as { projectPath?: string; fast?: boolean }) ?? {});
      send({ jsonrpc: "2.0", id, result });
    } catch (error) {
      send({
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
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
