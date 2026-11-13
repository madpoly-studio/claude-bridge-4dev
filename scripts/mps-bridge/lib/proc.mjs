// Spawn helpers: PATH lookup, run-and-capture, pnpm through npx, child env sanitising and process-tree kill.
import { execFile, execFileSync, spawn } from "node:child_process";
import { accessSync, constants as fsConstants, statSync } from "node:fs";
import path from "node:path";
import { EXIT, UserError } from "./errors.mjs";

export const PNPM_SPEC = "pnpm@9.15.9";

/** Env vars the backend/runner read as overrides. Stripped so the generated configs are the only input. */
export const BRIDGE_ENV_OVERRIDES = Object.freeze([
  "BRIDGE_PORT",
  "MAX_CONCURRENCY",
  "TASK_TIMEOUT_MINUTES",
  "ORCH_TICK_MINUTES",
  "WAKE_MODE",
  "JIRA_POLL_SECONDS",
  "CLAUDE_AUTH_MODE",
  "BRIDGE_PAIRING_TOKEN",
  "RUNNER_BOOTSTRAP_TOKEN",
  "ALLOWED_ORIGINS",
  "BRIDGE_CONFIG",
  "RUNNER_CONFIG",
]);

const IS_WINDOWS = process.platform === "win32";
const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";
/** Characters cmd.exe expands or splits on even inside double quotes. */
const UNSAFE_SHELL_ARG = /["%!\r\n]/;
const TASKKILL_TIMEOUT_MS = 10_000;
const TASKKILL_SYNC_TIMEOUT_MS = 3_000;

/**
 * Case-insensitive env lookup (Windows env copies keep the original key case, e.g. "Path").
 * @param {NodeJS.ProcessEnv} env
 * @param {string} name
 */
function envValue(env, name) {
  const key = Object.keys(env).find((k) => k.toUpperCase() === name);
  return key === undefined ? undefined : env[key];
}

/** @param {string} file */
function isRunnableFile(file) {
  try {
    if (!statSync(file).isFile()) {
      return false;
    }
    if (!IS_WINDOWS) {
      accessSync(file, fsConstants.X_OK);
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolves a command the way the shell would (PATH, plus PATHEXT on Windows) without spawning anything.
 * On Windows an extension-less name is only matched with a PATHEXT extension: `npx` resolves to `npx.cmd`,
 * never to the POSIX `npx` script that sits next to it.
 * @param {string} cmd
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string | null}
 */
export function which(cmd, env = process.env) {
  const exts = IS_WINDOWS
    ? (envValue(env, "PATHEXT") ?? DEFAULT_PATHEXT).split(";").filter((e) => e.length > 0)
    : [""];
  const hasKnownExt = IS_WINDOWS && exts.some((e) => cmd.toLowerCase().endsWith(e.toLowerCase()));
  const names = IS_WINDOWS ? [...(hasKnownExt ? [cmd] : []), ...exts.map((e) => cmd + e)] : [cmd];
  const dirs = cmd.includes("/") || cmd.includes("\\")
    ? [""]
    : (envValue(env, "PATH") ?? "").split(path.delimiter).filter((d) => d.length > 0);
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = dir === "" ? path.resolve(name) : path.join(dir.replace(/^"(.*)"$/, "$1"), name);
      if (isRunnableFile(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

/**
 * Builds the single command string used for `.cmd`/`.bat` targets (Node >= 24 deprecates args + shell: true).
 * @param {string} resolved
 * @param {readonly string[]} args
 * @returns {string}
 */
export function buildShellCommand(resolved, args) {
  for (const part of [resolved, ...args]) {
    if (UNSAFE_SHELL_ARG.test(part)) {
      throw new UserError(
        `Không chạy được "${path.basename(resolved)}": tham số chứa ký tự cmd.exe không cho phép (" % ! hoặc xuống dòng): ${part}`,
        EXIT.ENVIRONMENT,
      );
    }
  }
  return [resolved, ...args].map((a) => `"${a}"`).join(" ");
}

/**
 * @typedef {object} RunOptions
 * @property {string} [cwd]
 * @property {NodeJS.ProcessEnv} [env]
 * @property {"inherit" | "pipe"} [stdio] default "pipe"
 * @property {number} [timeoutMs] on timeout the process tree is killed and `timedOut` is true; the result arrives only
 *   after the kill has finished
 */

/**
 * @typedef {object} RunResult
 * @property {number | null} code
 * @property {string} stdout
 * @property {string} stderr
 * @property {boolean} timedOut
 */

/**
 * Runs a command to completion. Never rejects for a non-zero exit; a missing command throws UserError(…, 3).
 * @param {string} cmd
 * @param {readonly string[]} args
 * @param {RunOptions} [opts]
 * @returns {Promise<RunResult>}
 */
export function run(cmd, args, opts = {}) {
  const env = opts.env ?? process.env;
  const resolved = which(cmd, env);
  if (resolved === null) {
    return Promise.reject(new UserError(`Không tìm thấy lệnh "${cmd}" trong PATH.`, EXIT.ENVIRONMENT));
  }
  const inherit = opts.stdio === "inherit";
  const spawnOptions = {
    cwd: opts.cwd,
    env,
    stdio: /** @type {const} */ (["ignore", inherit ? "inherit" : "pipe", inherit ? "inherit" : "pipe"]),
    // false on purpose: with piped stdio, windowsHide would give the child its own hidden console, so a Ctrl+C
    // during preflight/build would kill this process and leave the child running headless.
    windowsHide: false,
  };
  let child;
  try {
    child = IS_WINDOWS && /\.(cmd|bat)$/i.test(resolved)
      ? spawn(buildShellCommand(resolved, args), { ...spawnOptions, shell: true })
      : spawn(resolved, [...args], { ...spawnOptions, shell: false });
  } catch (err) {
    return Promise.reject(err);
  }
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    /** @type {Promise<void>} */
    let killed = Promise.resolve();
    child.stdout?.setEncoding("utf8").on("data", (s) => { stdout += s; });
    child.stderr?.setEncoding("utf8").on("data", (s) => { stderr += s; });
    const timer = opts.timeoutMs === undefined
      ? null
      : setTimeout(() => {
        timedOut = true;
        if (child.pid !== undefined) {
          killed = killTree(child.pid);
        }
      }, opts.timeoutMs);
    child.on("error", (err) => {
      if (timer) {
        clearTimeout(timer);
      }
      reject(new UserError(`Không chạy được "${cmd}": ${err.message}`, EXIT.ENVIRONMENT));
    });
    child.on("close", (code) => {
      if (timer) {
        clearTimeout(timer);
      }
      // A timed-out result is only handed back once the tree kill has finished: "close" can fire as soon as the
      // direct child is gone while taskkill /T is still ending its descendants (git worktree add → git reset → filters),
      // and a caller that cleans up after a timeout must not race them. Grandchildren that inherited the pipes keep
      // "close" from firing until they are gone too (on POSIX, where only the direct child is killed, that is the wait).
      void killed.then(() => resolve({ code, stdout, stderr, timedOut }));
    });
  });
}

/**
 * `npx -y pnpm@9.15.9 ...args` (pnpm is usually not on PATH).
 * @param {readonly string[]} args
 * @param {RunOptions} [opts]
 */
export function pnpm(args, opts) {
  return run("npx", ["-y", PNPM_SPEC, ...args], opts);
}

/**
 * Copy of `base` without the bridge override variables, so a stray shell variable cannot change the generated config.
 * @param {NodeJS.ProcessEnv} [base]
 * @returns {NodeJS.ProcessEnv}
 */
export function cleanChildEnv(base = process.env) {
  const drop = new Set(BRIDGE_ENV_OVERRIDES);
  /** @type {NodeJS.ProcessEnv} */
  const out = {};
  for (const [key, value] of Object.entries(base)) {
    if (!drop.has(key.toUpperCase())) {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Kills a process and its descendants. Never throws.
 * @param {number} pid
 * @returns {Promise<void>}
 */
export function killTree(pid) {
  if (!IS_WINDOWS) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    execFile("taskkill", ["/pid", String(pid), "/T", "/F"], { timeout: TASKKILL_TIMEOUT_MS, windowsHide: true }, () => resolve());
  });
}

/**
 * Synchronous variant for the SIGHUP path (Windows gives about 5 s after the console closes).
 * @param {number} pid
 */
export function killTreeSync(pid) {
  try {
    if (IS_WINDOWS) {
      execFileSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
        timeout: TASKKILL_SYNC_TIMEOUT_MS,
        windowsHide: true,
        stdio: "ignore",
      });
    } else {
      process.kill(pid, "SIGKILL");
    }
  } catch {
    // Already gone, or taskkill timed out: best effort.
  }
}
