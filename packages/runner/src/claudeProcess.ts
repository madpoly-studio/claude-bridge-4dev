// One headless claude child process: spawn, prompt on stdin, stdout lines out, stderr tail, exit, tree kill,
// and cleanup of whatever it left running.
import { spawn, type ChildProcess } from "node:child_process";
import readline from "node:readline";
import { planSpawn } from "./commandResolver.js";
import { liveResources } from "./liveResources.js";
import { errorMessage, type Logger } from "./logger.js";
import { startOrphanReaper, type OrphanReaper } from "./orphanReaper.js";
import { killProcessTree, treeSpawnOptions, type KillTreeFn } from "./processTree.js";

const STDERR_TAIL_CHARS = 4096;

export interface ClaudeExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderrTail: string;
}

export interface ClaudeProcessOptions {
  command: readonly string[];
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  prompt: string;
  /** Called for every non-empty stdout line, in order. */
  onLine: (line: string) => void;
  killGraceMs: number;
  stdioDrainMs: number;
  /** win32: interval of the process-tree snapshots used to find leftovers after exit. */
  descendantScanMs: number;
  logger: Logger;
  /** Defaults to killProcessTree; tests inject a failing one. */
  killTree?: KillTreeFn;
}

export class SpawnError extends Error {}

export class ClaudeProcess {
  readonly pid: number;
  /**
   * Resolves after the exit, once leftover descendants were killed and stdio drained (both bounded).
   * Never resolves if the process never exits (a kill that did not work).
   */
  readonly exited: Promise<ClaudeExit>;
  private stderrTail = "";
  private exitSeen = false;
  private readonly reaper: OrphanReaper;

  private constructor(
    private readonly child: ChildProcess,
    private readonly options: ClaudeProcessOptions,
    spawnedAtMs: number,
  ) {
    this.pid = child.pid as number;
    liveResources.addChild(this.pid);
    this.reaper = startOrphanReaper(child, {
      spawnedAtMs,
      scanIntervalMs: options.descendantScanMs,
      logger: options.logger,
    });
    this.exited = this.watch();
  }

  /** True as soon as the OS reported the exit (before `exited` resolves). */
  get hasExited(): boolean {
    return this.exitSeen;
  }

  /** Spawns and waits for the OS to confirm the process started. Throws SpawnError otherwise. */
  static async start(options: ClaudeProcessOptions): Promise<ClaudeProcess> {
    let plan;
    try {
      plan = await planSpawn(options.command, options.args);
    } catch (err) {
      throw new SpawnError(`cannot resolve claude command: ${errorMessage(err)}`);
    }
    let child: ChildProcess;
    const spawnedAtMs = Date.now();
    try {
      child = spawn(plan.file, plan.args, {
        cwd: options.cwd,
        env: options.env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        windowsVerbatimArguments: plan.windowsVerbatimArguments,
        ...treeSpawnOptions(),
      });
    } catch (err) {
      throw new SpawnError(`failed to spawn ${plan.file}: ${errorMessage(err)}`);
    }
    const startError = await new Promise<Error | null>((resolve) => {
      child.once("spawn", () => resolve(null));
      child.once("error", (err) => resolve(err));
    });
    if (startError || child.pid === undefined) {
      throw new SpawnError(`failed to start ${plan.file}: ${startError ? startError.message : "no pid"}`);
    }
    child.on("error", (err) => options.logger.warn("claude process error", { error: err.message }));

    const proc = new ClaudeProcess(child, options, spawnedAtMs);
    // The prompt goes through stdin: no argv quoting issues on Windows, no length limit.
    child.stdin?.on("error", (err) => options.logger.debug("stdin closed early", { error: err.message }));
    child.stdin?.end(options.prompt, "utf8");
    return proc;
  }

  /** Kills the tree. Never throws; resolving does not mean the process is gone (see `exited`). */
  kill(): Promise<void> {
    const killTree = this.options.killTree ?? killProcessTree;
    return killTree(this.child, this.options.killGraceMs, this.options.logger).catch((err: unknown) => {
      this.options.logger.warn("killing claude process tree failed", { pid: this.pid, error: errorMessage(err) });
    });
  }

  private async watch(): Promise<ClaudeExit> {
    const { child, options } = this;
    const stdoutDone = new Promise<void>((resolve) => {
      if (!child.stdout) {
        resolve();
        return;
      }
      const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
      lines.on("line", (line) => {
        if (line.trim().length > 0) {
          options.onLine(line);
        }
      });
      lines.once("close", () => resolve());
    });
    const stderrDone = new Promise<void>((resolve) => {
      if (!child.stderr) {
        resolve();
        return;
      }
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_CHARS);
      });
      child.stderr.once("close", () => resolve());
    });

    const { code, signal } = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once("exit", (exitCode, exitSignal) => {
        this.exitSeen = true;
        resolve({ code: exitCode, signal: exitSignal });
      });
    });

    // Before draining: a leftover holding stdout open is one of the things this kills.
    await this.reaper.reap();
    liveResources.removeChild(this.pid);

    // A grandchild that inherited stdout can keep the pipe open after claude exits; do not wait forever.
    let drainTimer: NodeJS.Timeout | undefined;
    const drained = await Promise.race([
      Promise.all([stdoutDone, stderrDone]).then(() => true),
      new Promise<boolean>((resolve) => {
        drainTimer = setTimeout(() => resolve(false), options.stdioDrainMs);
      }),
    ]);
    clearTimeout(drainTimer);
    if (!drained) {
      options.logger.warn("stdio still open after claude exited, closing it", { pid: this.pid });
      child.stdout?.destroy();
      child.stderr?.destroy();
    }
    return { code, signal, stderrTail: this.stderrTail };
  }
}
