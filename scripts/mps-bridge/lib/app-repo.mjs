// The bridge checkout (APP_ROOT): safety checks before a fast-forward, pull, install and build. Used by `update`, by
// `start` when the build output is missing, and by setup.mjs (install + build).
import { EXIT, UserError } from "./errors.mjs";
import { APP_BRANCH, canonicalPath, samePath } from "./paths.mjs";
import { cleanChildEnv, pnpm, run } from "./proc.mjs";

const GIT_TIMEOUT_MS = 30_000;
const PULL_TIMEOUT_MS = 300_000;
/** --config.confirmModulesPurge=false: pnpm must never stop at an interactive "purge node_modules?" prompt. */
const INSTALL_ARGS = Object.freeze(["install", "--frozen-lockfile", "--config.confirmModulesPurge=false"]);
const BUILD_ARGS = Object.freeze(["-r", "run", "build"]);

/**
 * @param {string} appRoot
 * @param {string[]} args
 * @returns {Promise<{ ok: boolean, out: string, err: string }>}
 */
async function git(appRoot, args) {
  const r = await run("git", ["-C", appRoot, ...args], {
    env: { ...cleanChildEnv(), GIT_TERMINAL_PROMPT: "0" },
    timeoutMs: GIT_TIMEOUT_MS,
  });
  return { ok: r.code === 0 && !r.timedOut, out: r.stdout.trim(), err: r.stderr.trim() };
}

/**
 * G01-G04: the checkout must be its own git clone (a copy without .git would make git use a parent repo, and update
 * would pull that one), have an origin, be clean and be on main before it is fast-forwarded.
 * @param {string} appRoot
 * @returns {Promise<string[]>} Vietnamese errors, [] when update may proceed
 */
export async function checkAppRepo(appRoot) {
  const top = await git(appRoot, ["rev-parse", "--show-toplevel"]);
  if (!top.ok || top.out === "") {
    return [
      `Mã nguồn bridge ${appRoot} không phải git clone (${top.err || "git không trả lời"}). ` +
        'Lấy bridge bằng "git clone" rồi chạy setup trong bản clone đó.',
    ];
  }
  if (!samePath(canonicalPath(top.out), canonicalPath(appRoot))) {
    return [
      `Mã nguồn bridge ${appRoot} không phải git clone: không có .git riêng, git đang dùng repo cha ${top.out}. ` +
        'Không cập nhật để tránh pull nhầm repo đó. Lấy bridge bằng "git clone" rồi chạy setup trong bản clone đó.',
    ];
  }
  const errors = [];
  const origin = await git(appRoot, ["remote", "get-url", "origin"]);
  if (!origin.ok) {
    errors.push(
      `Bản clone ${appRoot} chưa có remote "origin": không biết tải bản mới từ đâu. ` +
        `Thêm bằng: git -C "${appRoot}" remote add origin <url>`,
    );
  }
  const status = await git(appRoot, ["status", "--porcelain"]);
  if (!status.ok || status.out !== "") {
    errors.push(
      `Bản clone ${appRoot} có thay đổi chưa commit; không cập nhật để tránh mất dữ liệu. ` +
        `Xem bằng git -C "${appRoot}" status, commit/stash rồi chạy lại. ` +
        "Nên dùng một bản clone RIÊNG để chạy bridge, không code trên đó.",
    );
  }
  const branch = await git(appRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!branch.ok || branch.out !== APP_BRANCH) {
    errors.push(
      `Bản clone ${appRoot} đang ở nhánh ${branch.ok ? branch.out : "?"}, cần ${APP_BRANCH} ` +
        `(git -C "${appRoot}" checkout ${APP_BRANCH}).`,
    );
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
    throw new UserError(`git pull trong ${appDir} thất bại (mã ${r.code ?? "timeout"}). Xem lỗi ở trên.`, EXIT.ENVIRONMENT);
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
