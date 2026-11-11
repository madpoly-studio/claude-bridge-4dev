// One headless claude child process: spawn, prompt on stdin, stdout lines out, stderr tail, exit, tree kill.
import { spawn, type ChildProcess } from "node:child_process";
import readline from "node:readline";
import { planSpawn } from "./commandResolver.js";
import { errorMessage, type Logger } from "./logger.js";
import { killProcessTree, treeSpawnOptions } from "./processTree.js";

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
  logger: Logger;
}

export class SpawnError extends Error {}

export class ClaudeProcess {
  readonly pid: number;
  readonly exited: Promise<ClaudeExit>;
  private stderrTail = "";

  private constructor(
    private readonly child: ChildProcess,
    private readonly options: ClaudeProcessOptions,
  ) {
    this.pid = child.pid as number;
    this.exited = this.watch();
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

    const proc = new ClaudeProcess(child, options);
    // The prompt goes through stdin: no argv quoting issues on Windows, no length limit.
    child.stdin?.on("error", (err) => options.logger.debug("stdin closed early", { error: err.message }));
    child.stdin?.end(options.prompt, "utf8");
    return proc;
  }

  kill(): Promise<void> {
    return killProcessTree(this.child, this.options.killGraceMs, this.options.logger);
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
      child.once("exit", (exitCode, exitSignal) => resolve({ code: exitCode, signal: exitSignal }));
    });

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
