import { spawn, type ChildProcess } from "node:child_process";
import { createConnection } from "node:net";
import { redactSecrets } from "./audit.js";
import { KkomkkomError } from "./errors.js";
import { readBody } from "./http.js";
import { resolveLang, t } from "./i18n.js";
import { nextEnv, resolveNextCli } from "./next.js";
import { installInterrupt, terminateGroup } from "./process.js";

export interface DevServer {
  url: string;
  owned: boolean;
  stop: () => Promise<void>;
}

export interface DevServerOptions {
  reuse?: boolean;
  /** Bounded readiness wait (default 60s). */
  startupTimeoutMs?: number;
  /** Bounded graceful shutdown before force-killing (default 5s). */
  stopTimeoutMs?: number;
  /** Test seam; defaults to the project's installed Next CLI. */
  nextCli?: string;
  /** Test seam; defaults to node:child_process.spawn. */
  spawnImpl?: typeof spawn;
}

const READY_POLL_MS = 250;
const DEFAULT_STARTUP_MS = 60_000;
const DEFAULT_STOP_MS = 5_000;
const MAX_LOG = 16_384;

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

async function waitForHttp(
  url: string,
  exited: Promise<void>,
  exitInfo: () => string | null,
  timeoutMs: number,
): Promise<{ timeout: true } | { reason: string } | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const exitedFirst = exitInfo();
    if (exitedFirst !== null) return { reason: exitedFirst };

    const fetched: { response: Response | null; exited?: boolean } = await Promise.race([
      fetch(url, { signal: AbortSignal.timeout(2000), redirect: "manual" })
        .then((response) => ({ response }))
        .catch(() => ({ response: null })),
      exited.then(() => ({ response: null, exited: true })),
    ]);

    if (fetched.exited) return { reason: exitInfo() ?? "exit" };
    if (fetched.response !== null) {
      const status = fetched.response.status;
      await fetched.response.body?.cancel().catch(() => {});
      // Let a queued exit event land before deciding this reply proves readiness.
      await new Promise((resolve) => setImmediate(resolve));
      // A descendant can answer after its parent died; never call that ready.
      const exitedAfterReply = exitInfo();
      if (exitedAfterReply !== null) return { reason: exitedAfterReply };
      if (status < 500) return null;
    }

    if (Date.now() >= deadline) return { timeout: true };
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(READY_POLL_MS, Math.max(0, deadline - Date.now()))));
  }
}

async function looksLikeNext(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000), redirect: "manual" });
    const body = await readBody(res, 20_000).then((read) => read.text).catch(() => "");
    return /_next\/|__next/.test(body) || res.headers.has("x-nextjs-cache");
  } catch {
    return false;
  }
}

export async function startDevServer(
  root: string,
  port: number,
  options: DevServerOptions = {},
): Promise<DevServer> {
  const url = `http://127.0.0.1:${port}`;

  if (await isPortOpen(port)) {
    if (!options.reuse || !(await looksLikeNext(url))) {
      throw new KkomkkomError("errPortInUse", { port });
    }
    return { url, owned: false, stop: async () => {} };
  }

  const cli = options.nextCli ?? resolveNextCli(root);
  if (!cli) throw new KkomkkomError("errNextMissing");

  const spawnImpl = options.spawnImpl ?? spawn;
  let child: ChildProcess;
  try {
    child = spawnImpl(process.execPath, [cli, "dev", "--hostname", "127.0.0.1", "-p", String(port)], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      env: nextEnv(),
      windowsHide: true,
    });
  } catch {
    throw new KkomkkomError("errDevStart", { reason: "spawn", log: "" });
  }

  let log = "";
  const append = (chunk: Buffer | string) => {
    log = (log + String(chunk)).slice(-MAX_LOG);
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);

  let exitInfo: string | null = null;
  let markExited = () => {};
  const exited = new Promise<void>((resolve) => {
    let done = false;
    markExited = () => {
      if (done) return;
      done = true;
      resolve();
    };
  });
  child.once("error", (error) => {
    if (exitInfo === null) exitInfo = `spawn ${error.name}`;
    markExited();
  });
  child.once("exit", (code, signal) => {
    if (exitInfo === null) exitInfo = `exit ${code ?? signal ?? "unknown"}`;
    markExited();
  });

  let removeInterrupt = () => {};
  let stopPromise: Promise<void> | null = null;
  const stop = (): Promise<void> => {
    if (stopPromise) return stopPromise;
    removeInterrupt();
    stopPromise = (async () => {
      const stopped = await terminateGroup(child.pid, options.stopTimeoutMs ?? DEFAULT_STOP_MS);
      if (!stopped) throw new KkomkkomError("errDevStop");
    })();
    return stopPromise;
  };
  removeInterrupt = installInterrupt(stop, (error) => {
    if (error instanceof KkomkkomError) {
      process.stderr.write(`kkomkkom: ${t(resolveLang(), error.key, error.vars)}\n`);
    }
  });

  let failure = await waitForHttp(url, exited, () => exitInfo, options.startupTimeoutMs ?? DEFAULT_STARTUP_MS);
  if (failure === null && exitInfo !== null) failure = { reason: exitInfo };
  if (failure !== null) {
    await stop();
    const logText = await redactSecrets(root, log.slice(-1500)).catch(() => "");
    if ("timeout" in failure) {
      throw new KkomkkomError("errDevTimeout", { log: logText });
    }
    throw new KkomkkomError("errDevStart", { reason: failure.reason, log: logText });
  }

  return { url, owned: true, stop };
}
