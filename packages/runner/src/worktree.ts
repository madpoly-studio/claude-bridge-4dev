// Pre-spawn worktree check (decision P7): a dirty worktree is reported as conflict, never worked on.
import { execFile } from "node:child_process";

const GIT_TIMEOUT_MS = 30_000;
const MAX_LISTED_ENTRIES = 5;

export type WorktreeStatus = { clean: true } | { clean: false; summary: string };

export class WorktreeCheckError extends Error {}

/** Runs `git -C <worktree> status --porcelain`. Throws WorktreeCheckError when git cannot run or the path is not a repo. */
export function checkWorktree(worktreePath: string): Promise<WorktreeStatus> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["-C", worktreePath, "status", "--porcelain"],
      { timeout: GIT_TIMEOUT_MS, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const detail = String(stderr).trim() || err.message;
          reject(new WorktreeCheckError(`git status failed in ${worktreePath}: ${detail}`));
          return;
        }
        const entries = String(stdout)
          .split(/\r?\n/)
          .filter((line) => line.trim().length > 0);
        if (entries.length === 0) {
          resolve({ clean: true });
          return;
        }
        const listed = entries.slice(0, MAX_LISTED_ENTRIES).join("; ");
        const more = entries.length > MAX_LISTED_ENTRIES ? ` (+${entries.length - MAX_LISTED_ENTRIES} more)` : "";
        resolve({ clean: false, summary: `worktree has ${entries.length} uncommitted change(s): ${listed}${more}` });
      },
    );
  });
}
