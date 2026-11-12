#!/usr/bin/env node
// One-time bootstrap: create the workspace, clone or fast-forward app/, install, build, then `cli.mjs init`.
// Standalone on purpose (built-ins only, no lib/ imports): it may fast-forward the very checkout it lives in.
//
//   node D:\mps-claude-bridge\app\scripts\mps-bridge\setup.mjs [--workspace <dir>]
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

const DEFAULT_WORKSPACE = "D:/mps-claude-bridge";
const APP_REPO_URL = "https://github.com/madpoly-studio/claude-bridge-4dev.git";
const APP_BRANCH = "main";
const PNPM_SPEC = "pnpm@9.15.9";
/** Same value as lib/preflight.mjs MIN_NODE_MAJOR (this file cannot import lib/). */
const MIN_NODE_MAJOR = 22;
const EXIT_RUNTIME = 1;
const EXIT_ENVIRONMENT = 3;
const IS_WINDOWS = process.platform === "win32";
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
/** Same file as lib/lock.mjs uses. */
const LOCK_FILE = path.join("data", "mps-bridge.lock");
const ACL_GRANT_SIDS = Object.freeze(["S-1-5-18", "S-1-5-32-544"]);

class SetupError extends Error {}

/**
 * "host/org/repo" for https, https://user@, ssh:// and scp-style (git@host:org/repo) remotes. Same as lib/app-repo.mjs.
 * @param {string} url
 */
function normaliseRepoUrl(url) {
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

/** @param {number} pid */
function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return /** @type {NodeJS.ErrnoException} */ (err).code === "EPERM";
  }
}

/**
 * Workspace lock shared with start/update (lib/lock.mjs): refuses while another live process holds it.
 * Released when this process exits.
 * @param {string} root
 */
function acquireLock(root) {
  const file = path.join(root, LOCK_FILE);
  mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(file, JSON.stringify({ pid: process.pid, command: "setup", started: new Date().toISOString() }), {
        flag: "wx",
      });
      process.on("exit", () => {
        try {
          unlinkSync(file);
        } catch {
          // Already removed.
        }
      });
      return;
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err).code !== "EEXIST") {
        throw err;
      }
    }
    let holder = null;
    try {
      holder = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      holder = null;
    }
    if (Number.isInteger(holder?.pid) && isProcessAlive(holder.pid)) {
      throw new SetupError(
        `Thư mục làm việc đang được dùng bởi tiến trình ${holder.pid} ("${holder.command}"). ` +
          `Đóng cửa sổ start.cmd / update.cmd rồi chạy lại setup. Nếu chắc chắn không còn cửa sổ nào chạy, xóa ${file}.`,
      );
    }
    try {
      unlinkSync(file);
    } catch {
      // Removed meanwhile.
    }
  }
  throw new SetupError(`Không tạo được file khóa ${file}. Thử lại sau vài giây.`);
}

/**
 * Absolute System32 path: a Git-for-Windows PATH puts a coreutils `whoami` ahead of the Windows one.
 * @param {string} exe
 */
function system32(exe) {
  return path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", exe);
}

/**
 * Windows: only the current user, SYSTEM and Administrators may open the new (still empty) workspace. Never throws.
 * @param {string} root
 * @returns {string | null} warning
 */
function lockDownAcl(root) {
  if (!IS_WINDOWS) {
    return null;
  }
  const who = spawnSync(system32("whoami.exe"), ["/user", "/fo", "csv", "/nh"], { encoding: "utf8", windowsHide: true });
  const sid = /S-1-[0-9-]+/.exec(who.stdout ?? "")?.[0];
  if (sid === undefined) {
    return `Không xác định được tài khoản Windows hiện tại; chưa khóa quyền truy cập ${root}.`;
  }
  const grants = [sid, ...ACL_GRANT_SIDS].map((s) => `*${s}:(OI)(CI)F`);
  const r = spawnSync(system32("icacls.exe"), [root, "/inheritance:r", "/grant:r", ...grants], { encoding: "utf8", windowsHide: true });
  return r.status === 0 ? null : `Không khóa được quyền truy cập ${root} (${(r.stderr || r.stdout || "").trim()}).`;
}

/**
 * @param {string[]} args
 * @returns {{ ok: boolean, out: string, missing: boolean }}
 */
function gitCapture(args) {
  const r = spawnSync("git", args, { encoding: "utf8", env: GIT_ENV, windowsHide: true });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim(), missing: r.error !== undefined };
}

/**
 * @param {string[]} args
 * @param {string} what Vietnamese description for the error
 */
function gitInherit(args, what) {
  const r = spawnSync("git", args, { stdio: "inherit", env: GIT_ENV });
  if (r.status !== 0) {
    throw new SetupError(`${what} thất bại (mã ${r.status ?? "?"}). Xem lỗi ở trên.`);
  }
}

/**
 * `npx -y pnpm@9.15.9 <args>` in app/. Every argument is a constant, so the Windows shell string is safe.
 * @param {string} appDir
 * @param {string[]} args
 * @param {string} what
 */
function pnpmInherit(appDir, args, what) {
  const full = ["-y", PNPM_SPEC, ...args];
  const r = IS_WINDOWS
    ? spawnSync(`npx ${full.join(" ")}`, { cwd: appDir, stdio: "inherit", shell: true })
    : spawnSync("npx", full, { cwd: appDir, stdio: "inherit" });
  if (r.status !== 0) {
    throw new SetupError(`${what} thất bại (mã ${r.status ?? "?"}). Xem lỗi ở trên rồi chạy lại setup.`);
  }
}

function checkPrerequisites() {
  const major = Number(process.versions.node.split(".")[0]);
  if (major < MIN_NODE_MAJOR) {
    throw new SetupError(`Cần Node.js >= ${MIN_NODE_MAJOR} (đang chạy ${process.version}).`);
  }
  if (gitCapture(["--version"]).missing) {
    throw new SetupError("Không tìm thấy git trong PATH. Cài Git for Windows: https://git-scm.com/download/win rồi mở lại cửa sổ.");
  }
}

/**
 * Clone when app/ is missing or empty; fast-forward when it is a clean clone of the official repo on main.
 * @param {string} appDir
 */
function prepareApp(appDir) {
  if (!existsSync(appDir) || readdirSync(appDir).length === 0) {
    console.log(`Đang clone ${APP_REPO_URL} vào ${appDir}…`);
    gitInherit(["clone", "--branch", APP_BRANCH, APP_REPO_URL, appDir], "git clone");
    return;
  }
  const origin = existsSync(path.join(appDir, ".git")) ? gitCapture(["-C", appDir, "remote", "get-url", "origin"]) : null;
  if (origin === null || !origin.ok || normaliseRepoUrl(origin.out) !== normaliseRepoUrl(APP_REPO_URL)) {
    throw new SetupError(`app\\ tồn tại nhưng không phải bản clone của ${APP_REPO_URL}.`);
  }
  const status = gitCapture(["-C", appDir, "status", "--porcelain"]);
  if (!status.ok || status.out !== "") {
    throw new SetupError(
      "app\\ có thay đổi chưa commit; không cập nhật để tránh mất dữ liệu. Commit/stash hoặc xóa app\\ rồi chạy lại.",
    );
  }
  const branch = gitCapture(["-C", appDir, "rev-parse", "--abbrev-ref", "HEAD"]);
  if (!branch.ok || branch.out !== APP_BRANCH) {
    throw new SetupError(`app\\ đang ở nhánh ${branch.ok ? branch.out : "?"}, cần ${APP_BRANCH}.`);
  }
  console.log("app\\ đã có: đang cập nhật (git pull --ff-only)…");
  gitInherit(["-C", appDir, "pull", "--ff-only", "origin", APP_BRANCH], "git pull");
}

/** @returns {number} exit code */
function main() {
  let parsed;
  try {
    parsed = parseArgs({ options: { workspace: { type: "string" } }, strict: true });
  } catch (err) {
    console.error(`${/** @type {Error} */ (err).message}\nCách dùng: node setup.mjs [--workspace <thư mục>]`);
    return EXIT_RUNTIME;
  }
  const root = path.resolve(parsed.values.workspace ?? DEFAULT_WORKSPACE);
  const appDir = path.join(root, "app");
  try {
    checkPrerequisites();
    const existed = existsSync(root);
    mkdirSync(root, { recursive: true });
    if (existed) {
      acquireLock(root);
    } else {
      const aclWarning = lockDownAcl(root);
      if (aclWarning !== null) {
        console.log(`[CẢNH BÁO] ${aclWarning}`);
      }
    }
    prepareApp(appDir);
    console.log("Đang cài thư viện (pnpm install)…");
    pnpmInherit(appDir, ["install", "--frozen-lockfile", "--config.confirmModulesPurge=false"], "pnpm install");
    console.log("Đang build…");
    pnpmInherit(appDir, ["-r", "run", "build"], "Build");
  } catch (err) {
    if (err instanceof SetupError) {
      console.error(`[LỖI] ${err.message}`);
      return EXIT_ENVIRONMENT;
    }
    throw err;
  }
  const cli = path.join(appDir, "scripts", "mps-bridge", "cli.mjs");
  const init = spawnSync(process.execPath, [cli, "init", "--workspace", root], { stdio: "inherit" });
  if (init.status !== 0) {
    return init.status ?? EXIT_RUNTIME;
  }
  console.log("");
  console.log("Cài đặt xong. Các bước tiếp theo:");
  console.log(`  1. Mở ${path.join(root, "settings.json")} và điền mọi chỗ <...> (Jira token, project, repo).`);
  console.log(`  2. Chạy ${path.join(root, "start.cmd")}.`);
  console.log(`  Hướng dẫn chi tiết: ${path.join(root, "HUONG-DAN.txt")}`);
  return 0;
}

process.exitCode = main();
