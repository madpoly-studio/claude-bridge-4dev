// Workspace lock (data/mps-bridge.lock): only one start/update/setup may touch a workspace at a time.
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { EXIT, UserError } from "./errors.mjs";

export const LOCK_FILE_NAME = "mps-bridge.lock";

/**
 * @typedef {{ pid: number, command: string, started: string }} LockInfo
 */

/**
 * @param {number} pid
 * @returns {boolean} true when a process with this PID exists (EPERM means it exists but belongs to someone else)
 */
export function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return /** @type {NodeJS.ErrnoException} */ (err).code === "EPERM";
  }
}

/**
 * @param {string} file
 * @returns {LockInfo | null} null when the file is missing or unreadable
 */
function readLock(file) {
  try {
    const info = JSON.parse(readFileSync(file, "utf8"));
    return Number.isInteger(info?.pid) ? info : null;
  } catch {
    return null;
  }
}

/**
 * Takes the lock or throws UserError(3). A lock left by a dead process is replaced. The lock is released by the
 * returned function and, as a fallback, when this process exits.
 * @param {string} dataDir
 * @param {string} command "start" | "update" | "setup"
 * @returns {() => void} release
 */
export function acquireWorkspaceLock(dataDir, command) {
  mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, LOCK_FILE_NAME);
  /** @type {LockInfo} */
  const mine = { pid: process.pid, command, started: new Date().toISOString() };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(file, JSON.stringify(mine), { encoding: "utf8", flag: "wx" });
      const release = () => {
        if (readLock(file)?.pid === process.pid) {
          try {
            unlinkSync(file);
          } catch {
            // Already removed.
          }
        }
        process.off("exit", release);
      };
      process.on("exit", release);
      return release;
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err).code !== "EEXIST") {
        throw err;
      }
    }
    const holder = readLock(file);
    if (holder !== null && holder.pid !== process.pid && isProcessAlive(holder.pid)) {
      throw new UserError(
        `Thư mục làm việc đang được dùng bởi tiến trình ${holder.pid} ("${holder.command}", từ ${holder.started}). ` +
          "Đóng cửa sổ start.cmd / update.cmd đang chạy rồi thử lại. " +
          `Nếu chắc chắn không còn cửa sổ nào chạy, xóa file ${file}.`,
        EXIT.ENVIRONMENT,
      );
    }
    // Stale (dead PID or unreadable): replace it.
    try {
      unlinkSync(file);
    } catch {
      // Removed by someone else meanwhile; the next attempt decides.
    }
  }
  throw new UserError(`Không tạo được file khóa ${file}. Thử lại sau vài giây.`, EXIT.ENVIRONMENT);
}
