// Killing the whole claude process tree (claude spawns Bash, MCP stdio servers, ...).
import { execFile, type ChildProcess } from "node:child_process";
import type { Logger } from "./logger.js";

const TASKKILL_TIMEOUT_MS = 15_000;

/** Spawn option so that POSIX children lead their own process group and can be killed as a tree. */
export function treeSpawnOptions(): { detached: boolean } {
  return { detached: process.platform !== "win32" };
}

/**
 * win32: `taskkill /pid <pid> /T /F`. POSIX: SIGTERM to the process group, SIGKILL after `graceMs`
 * if the child has not exited. Never throws; failures are logged.
 */
export async function killProcessTree(child: ChildProcess, graceMs: number, logger: Logger): Promise<void> {
  const pid = child.pid;
  if (pid === undefined || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      execFile("taskkill", ["/pid", String(pid), "/T", "/F"], { timeout: TASKKILL_TIMEOUT_MS, windowsHide: true }, (err, _out, stderr) => {
        // taskkill fails harmlessly when the process exited in the meantime.
        if (err && child.exitCode === null && child.signalCode === null) {
          logger.warn("taskkill failed", { pid, error: String(stderr).trim() || err.message });
        }
        resolve();
      });
    });
    return;
  }

  const signalGroup = (signal: NodeJS.Signals): void => {
    try {
      process.kill(-pid, signal);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ESRCH") {
        logger.warn("killing process group failed", { pid, signal, error: (err as Error).message });
      }
    }
  };
  signalGroup("SIGTERM");
  const exited = new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
    } else {
      child.once("exit", () => resolve());
    }
  });
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), graceMs);
  });
  const outcome = await Promise.race([exited.then(() => "exited" as const), timedOut]);
  clearTimeout(timer);
  if (outcome === "timeout") {
    logger.warn("process did not exit after SIGTERM, sending SIGKILL", { pid, grace_ms: graceMs });
    signalGroup("SIGKILL");
  }
}
