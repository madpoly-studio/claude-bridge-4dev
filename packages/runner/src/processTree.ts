// Killing the whole claude process tree (claude spawns Bash, MCP stdio servers, ...).
import { execFile, execFileSync, type ChildProcess } from "node:child_process";
import type { Logger } from "./logger.js";

const TASKKILL_TIMEOUT_MS = 15_000;
/** Second-signal path: a blocked synchronous taskkill must not keep the runner from exiting. */
const TASKKILL_SYNC_TIMEOUT_MS = 5_000;

/** Kills a process tree; injectable so tests can simulate a kill that does not work. */
export type KillTreeFn = (child: ChildProcess, graceMs: number, logger: Logger) => Promise<void>;

/** Spawn option so that POSIX children lead their own process group and can be killed as a tree. */
export function treeSpawnOptions(): { detached: boolean } {
  return { detached: process.platform !== "win32" };
}

/**
 * win32: `taskkill /pid <pid> /T /F`. POSIX: SIGTERM to the process group, SIGKILL after `graceMs`
 * if the child has not exited. Never throws; failures are logged. Survivors of an already-exited child are
 * the orphan reaper's job.
 */
export const killProcessTree: KillTreeFn = async (child, graceMs, logger) => {
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

  signalGroup(pid, "SIGTERM", logger);
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
    signalGroup(pid, "SIGKILL", logger);
  }
};

/** POSIX: SIGKILL to the process group led by `pid`. Returns false when the group no longer exists. */
export function killProcessGroupNow(pid: number, logger: Logger): boolean {
  return signalGroup(pid, "SIGKILL", logger);
}

/** win32: `taskkill /F /T /PID a /PID b ...` in one call. Never throws; failures are logged. */
export function taskkillTrees(pids: readonly number[], logger: Logger): Promise<void> {
  const args = ["/F", "/T", ...pids.flatMap((pid) => ["/PID", String(pid)])];
  return new Promise<void>((resolve) => {
    execFile("taskkill", args, { timeout: TASKKILL_TIMEOUT_MS, windowsHide: true }, (err, _out, stderr) => {
      if (err) {
        // Also non-zero when one of them exited in the meantime; the others are still killed.
        logger.warn("taskkill reported errors", { pids: pids.join(","), error: String(stderr).trim() || err.message });
      }
      resolve();
    });
  });
}

/** Synchronous tree kill for the emergency exit path. Never throws. */
export function killProcessTreeSync(pid: number, logger: Logger): void {
  if (process.platform !== "win32") {
    killProcessGroupNow(pid, logger);
    return;
  }
  try {
    execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { timeout: TASKKILL_SYNC_TIMEOUT_MS, windowsHide: true, stdio: "ignore" });
  } catch (err) {
    // Exits non-zero when the process is already gone.
    logger.debug("taskkill (sync) failed", { pid, error: (err as Error).message });
  }
}

function signalGroup(pid: number, signal: NodeJS.Signals, logger: Logger): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ESRCH") {
      logger.warn("killing process group failed", { pid, signal, error: (err as Error).message });
    }
    return false;
  }
}
