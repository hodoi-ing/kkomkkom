import { spawn, type ChildProcess } from "node:child_process";
import { createConnection } from "node:net";

export interface DevServer {
  url: string;
  owned: boolean;
  stop: () => Promise<void>;
}

export function isPortOpen(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host });
    const done = (open: boolean) => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(500);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

function stopChild(child: ChildProcess): void {
  if (child.exitCode !== null || child.pid === undefined) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
}

async function waitForHttp(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000), redirect: "manual" });
      if (res.status < 500) return true;
    } catch {
      // not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

async function looksLikeNext(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000), redirect: "manual" });
    const body = (await res.text()).slice(0, 20_000);
    return /_next\/|__next/.test(body) || res.headers.has("x-nextjs-cache");
  } catch {
    return false;
  }
}

export async function startDevServer(root: string, port: number): Promise<DevServer> {
  const url = `http://127.0.0.1:${port}`;

  if (await isPortOpen(port)) {
    if (!(await looksLikeNext(url))) {
      throw new Error(
        `${port}번 포트가 다른 프로그램에 쓰이고 있습니다. --port로 다른 번호를 지정하거나 그 프로그램을 종료해주세요.`,
      );
    }
    return { url, owned: false, stop: async () => {} };
  }

  const child = spawn("npx", ["next", "dev", "-p", String(port)], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
  });

  let log = "";
  child.stdout?.on("data", (chunk) => (log += chunk));
  child.stderr?.on("data", (chunk) => (log += chunk));

  const ready = await waitForHttp(url, 60_000);
  if (!ready) {
    stopChild(child);
    throw new Error(`60초 안에 개발 서버가 뜨지 않았습니다.\n${log.slice(-1500)}`);
  }

  return {
    url,
    owned: true,
    stop: async () => {
      stopChild(child);
      await new Promise((resolve) => setTimeout(resolve, 300));
    },
  };
}
