// Starts the runner in-process against a FakeBus, with a temp git worktree and the fake claude fixture.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseConfig, type RunnerConfig } from "../../src/config.js";
import { createLogger, type Logger } from "../../src/logger.js";
import type { KillTreeFn } from "../../src/processTree.js";
import { runSlots } from "../../src/runner.js";
import type { RunnerTimings } from "../../src/timings.js";
import { FakeBus } from "./fakeBus.js";

export const FAKE_CLAUDE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/fake-claude.mjs");
export const WORKER_ID = "w-test-01";

export const hasGit = spawnSync("git", ["--version"], { windowsHide: true }).status === 0;

export const FAST_TIMINGS: Partial<RunnerTimings> = {
  startedFallbackMs: 1_000,
  eventFlushIntervalMs: 50,
  eventMaxBatch: 10,
  killGraceMs: 500,
  shutdownGraceMs: 3_000,
  stdioDrainMs: 500,
  longPollWaitSeconds: 1,
  requestTimeoutMs: 5_000,
  backoff: { baseMs: 20, capMs: 200 },
};

export interface Harness {
  bus: FakeBus;
  config: RunnerConfig;
  tmpDir: string;
  worktree: string;
  recordFile: string;
  logLines: string[];
  /** Starts graceful shutdown (like SIGINT) without tearing the fake bus down. */
  abort(): void;
  /** Resolves when the runner has stopped. */
  done: Promise<void>;
  /** Shuts the runner down, then stops the bus and deletes temp files. */
  stop(): Promise<void>;
}

export interface HarnessOptions {
  slotEnv?: Record<string, string>;
  timings?: Partial<RunnerTimings>;
  /** false: worktree is a plain directory (not a git repo). */
  gitRepo?: boolean;
  heartbeatSeconds?: number;
  configure?: (raw: Record<string, unknown>) => void;
  killTree?: KillTreeFn;
}

export async function startHarness(options: HarnessOptions = {}): Promise<Harness> {
  const bus = new FakeBus();
  await bus.start();
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "runner-test-"));
  const worktree = path.join(tmpDir, "worktree");
  mkdirSync(worktree);
  if (options.gitRepo !== false) {
    execFileSync("git", ["init", "-q", worktree], { windowsHide: true });
  }
  const tokenFile = path.join(tmpDir, "runner-bootstrap.token");
  writeFileSync(tokenFile, `${bus.bootstrapToken}\n`);
  const recordFile = path.join(tmpDir, "fake-claude-record.json");

  const raw: Record<string, unknown> = {
    bus_url: bus.url,
    bootstrap_token_file: tokenFile,
    host: "test-host",
    heartbeat_seconds: options.heartbeatSeconds ?? 1,
    claude_command: [process.execPath, FAKE_CLAUDE],
    slots: [
      {
        worker_id: WORKER_ID,
        repo: "sample-repo",
        worktree_path: worktree,
        allowed_tools: ["Read", "Grep", "Bash(git:*)"],
        env: { FAKE_CLAUDE_RECORD_FILE: recordFile, ...options.slotEnv },
      },
    ],
  };
  options.configure?.(raw);
  const config = parseConfig(raw, tmpDir);

  const logLines: string[] = [];
  const logger: Logger = createLogger({ level: "debug", sink: (_level, line) => logLines.push(line) });
  const controller = new AbortController();
  const done = runSlots(config, {
    signal: controller.signal,
    logger,
    timings: { ...FAST_TIMINGS, ...options.timings },
    killTree: options.killTree,
  });

  return {
    bus,
    config,
    tmpDir,
    worktree,
    recordFile,
    logLines,
    done,
    abort: () => controller.abort(),
    async stop() {
      controller.abort();
      await done;
      await bus.stop();
      rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
