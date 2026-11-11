// What this process must not leave behind if it exits abruptly (second Ctrl+C, crash): running claude
// trees and the temp dirs holding MCP configs with task tokens.
import { rmSync } from "node:fs";
import type { Logger } from "./logger.js";
import { killProcessTreeSync } from "./processTree.js";

export class LiveResources {
  private readonly childPids = new Set<number>();
  private readonly tempDirs = new Set<string>();

  addChild(pid: number): void {
    this.childPids.add(pid);
  }

  removeChild(pid: number): void {
    this.childPids.delete(pid);
  }

  addTempDir(dir: string): void {
    this.tempDirs.add(dir);
  }

  removeTempDir(dir: string): void {
    this.tempDirs.delete(dir);
  }

  /**
   * Synchronously kills every registered process tree and deletes every registered temp dir, then forgets
   * them. Safe to call from a signal handler or process 'exit'. Never throws.
   */
  cleanupSync(logger: Logger): void {
    for (const pid of this.childPids) {
      logger.warn("killing claude process tree before exit", { pid });
      killProcessTreeSync(pid, logger);
    }
    this.childPids.clear();
    for (const dir of this.tempDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch (err) {
        // Never log the content: the dir holds a task token.
        logger.error("cannot delete task temp dir before exit", { dir, error: (err as Error).message });
      }
    }
    this.tempDirs.clear();
  }
}

/** Process-wide registry: signals and 'exit' are process-wide too. */
export const liveResources = new LiveResources();
