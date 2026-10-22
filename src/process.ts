import { spawn } from "node:child_process";

/** True while the process group still has at least one member. */
export function groupAlive(pid: number): boolean {
  try {
    process.kill(process.platform === "win32" ? pid : -pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(process.platform === "win32" ? pid : -pid, signal);
  } catch {
    // The group is already gone.
  }
}

function waitGone(pid: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      if (!groupAlive(pid)) {
        resolve(true);
        return;
      }
      if (Date.now() >= deadline) {
        resolve(false);
        return;
      }
      setTimeout(check, 50);
    };
    check();
  });
}

function taskkill(pid: number): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const done = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve();
    };
    let killer;
    try {
      killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } catch {
      done();
      return;
    }
    killer.once("error", done);
    killer.once("close", done);
    timer = setTimeout(done, 2000);
  });
}

/**
 * Stop the process group led by pid. A parent that exited first does not hide
 * descendants that still hold its group, pipes or port. Returns false when the
 * final bounded wait still sees live members.
 */
export async function terminateGroup(
  pid: number | undefined,
  gracefulMs: number,
  forceMs = 2000,
): Promise<boolean> {
  if (pid === undefined) return true;

  if (process.platform === "win32") {
    await taskkill(pid);
    return waitGone(pid, forceMs);
  }

  if (!groupAlive(pid)) return true;
  signalGroup(pid, "SIGTERM");
  if (await waitGone(pid, gracefulMs)) return true;
  signalGroup(pid, "SIGKILL");
  return waitGone(pid, forceMs);
}
