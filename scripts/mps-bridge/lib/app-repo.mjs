// The app/ clone: safety checks before a fast-forward, pull, install and build. Used by `update` and by `start`
// when the build output is missing. setup.mjs keeps its own copy of these rules because it must run standalone.
import { existsSync } from "node:fs";
import path from "node:path";
import { EXIT, UserError } from "./errors.mjs";
import { APP_BRANCH, APP_REPO_URL } from "./paths.mjs";
import { cleanChildEnv, pnpm, run } from "./proc.mjs";

const GIT_TIMEOUT_MS = 30_000;
const PULL_TIMEOUT_MS = 300_000;
/** --config.confirmModulesPurge=false: pnpm must never stop at an interactive "purge node_modules?" prompt. */
const INSTALL_ARGS = Object.freeze(["install", "--frozen-lockfile", "--config.confirmModulesPurge=false"]);
const BUILD_ARGS = Object.freeze(["-r", "run", "build"]);

/**
 * "host/org/repo" for any common form of a remote URL: https://host/org/repo.git, https://user@host/org/repo,
 * ssh://git@host:22/org/repo.git, git@host:org/repo.git. Copied in setup.mjs (standalone).
 * @param {string} url
 */
export function normaliseRepoUrl(url) {
  let u = url.trim().toLowerCase();
  const scp = /^[^@/]+@([^:/]+):(?!\d+\/)(.+)$/.exec(u);
  if (!u.includes("://") && scp !== null) {
    u = `${scp[1]}/${scp[2]}`;
  } else {
    u = u
      .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
      .replace(/^[^@/]+@/, "")
      .replace(/^([^/:]+):\d+\//, "$1/");
  }
  return u.replace(/\/+$/, "").replace(/\.git$/, "").replace(/\/+$/, "");
}

/**
 * @param {string} appDir
 * @param {string[]} args
 */
async function git(appDir, args) {
  const r = await run("git", ["-C", appDir, ...args], {
    env: { ...cleanChildEnv(), GIT_TERMINAL_PROMPT: "0" },
    timeoutMs: GIT_TIMEOUT_MS,
  });
  return { ok: r.code === 0 && !r.timedOut, out: r.stdout.trim() };
}

/**
 * G01-G03: app/ must be a clean clone of the official repo on main before it is fast-forwarded.
 * @param {string} appDir
 * @returns {Promise<string[]>} errors
 */
export async function checkAppRepo(appDir) {
  const origin = existsSync(path.join(appDir, ".git")) ? await git(appDir, ["remote", "get-url", "origin"]) : null;
  if (origin === null || !origin.ok || normaliseRepoUrl(origin.out) !== normaliseRepoUrl(APP_REPO_URL)) {
    return [`app\\ tồn tại nhưng không phải bản clone của ${APP_REPO_URL}.`];
  }
  const errors = [];
  const status = await git(appDir, ["status", "--porcelain"]);
  if (!status.ok || status.out !== "") {
    errors.push("app\\ có thay đổi chưa commit; không cập nhật để tránh mất dữ liệu. Commit/stash hoặc xóa app\\ rồi chạy lại.");
  }
  const branch = await git(appDir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!branch.ok || branch.out !== APP_BRANCH) {
    errors.push(`app\\ đang ở nhánh ${branch.ok ? branch.out : "?"}, cần ${APP_BRANCH}.`);
  }
  return errors;
}

/**
 * `git pull --ff-only origin main`, output shown in the console.
 * @param {string} appDir
 */
export async function pullApp(appDir) {
  const r = await run("git", ["-C", appDir, "pull", "--ff-only", "origin", APP_BRANCH], {
    env: { ...cleanChildEnv(), GIT_TERMINAL_PROMPT: "0" },
    stdio: "inherit",
    timeoutMs: PULL_TIMEOUT_MS,
  });
  if (r.code !== 0 || r.timedOut) {
    throw new UserError(`git pull trong app\\ thất bại (mã ${r.code ?? "timeout"}). Xem lỗi ở trên.`, EXIT.ENVIRONMENT);
  }
}

/**
 * @param {string} appDir
 * @returns {Promise<boolean>}
 */
export async function installApp(appDir) {
  const r = await pnpm(INSTALL_ARGS, { cwd: appDir, env: cleanChildEnv(), stdio: "inherit" });
  return r.code === 0;
}

/**
 * @param {string} appDir
 * @returns {Promise<boolean>}
 */
export async function buildApp(appDir) {
  const r = await pnpm(BUILD_ARGS, { cwd: appDir, env: cleanChildEnv(), stdio: "inherit" });
  return r.code === 0;
}
