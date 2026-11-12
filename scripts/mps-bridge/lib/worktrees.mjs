// One detached git worktree per worker slot. Creates missing ones, stashes leftover work in dirty ones (never deletes
// or resets), and warns about repo setups that weaken the worker sandbox.
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { EXIT, UserError } from "./errors.mjs";
import { canonicalPath } from "./paths.mjs";
import { cleanChildEnv, run } from "./proc.mjs";

const GIT_TIMEOUT_MS = 30_000;
const GIT_FETCH_TIMEOUT_MS = 180_000;
const REPO_CLAUDE_SETTINGS = ".claude/settings.json";
const SLOT_DIR_RE = /^(.+)-(\d{2,})$/;

/**
 * @typedef {import("./generate.mjs").WorktreeSpec} WorktreeSpec
 * @typedef {import("./paths.mjs").WorkspacePaths} WorkspacePaths
 * @typedef {{ created: string[], dirty: string[], stashed: string[], warnings: string[] }} WorktreeReport
 */

/** Never prompt for credentials: a hidden prompt would hang start. */
function gitEnv() {
  return { ...cleanChildEnv(), GIT_TERMINAL_PROMPT: "0" };
}

/**
 * @param {string[]} args
 * @param {number} [timeoutMs]
 */
async function git(args, timeoutMs = GIT_TIMEOUT_MS) {
  const result = await run("git", args, { env: gitEnv(), timeoutMs });
  const stderr = result.timedOut ? `quá ${Math.round(timeoutMs / 1000)} giây` : result.stderr.trim();
  return { ok: result.code === 0 && !result.timedOut, stdout: result.stdout.trim(), stderr };
}

/** @param {string} p */
function comparablePath(p) {
  const c = canonicalPath(path.resolve(p));
  return process.platform === "win32" ? c.toLowerCase() : c;
}

/**
 * Absolute git common dir of `dir`, or null when `dir` is not inside a git repository.
 * @param {string} dir
 */
async function commonDir(dir) {
  const r = await git(["-C", dir, "rev-parse", "--git-common-dir"]);
  return r.ok && r.stdout !== "" ? comparablePath(path.resolve(dir, r.stdout)) : null;
}

/** @param {string} p */
function isDir(p) {
  return statSync(p, { throwIfNoEntry: false })?.isDirectory() ?? false;
}

/**
 * Worktree paths git has registered for `repoPath` (comparable form).
 * @param {string} repoPath
 * @returns {Promise<Set<string>>}
 */
async function registeredWorktrees(repoPath) {
  const r = await git(["-C", repoPath, "worktree", "list", "--porcelain"]);
  const paths = r.stdout
    .split(/\r?\n/)
    .filter((line) => line.startsWith("worktree "))
    .map((line) => comparablePath(line.slice("worktree ".length)));
  return new Set(paths);
}

/**
 * @param {WorktreeSpec[]} specs
 * @param {WorkspacePaths} p
 * @returns {Promise<WorktreeReport>}
 */
export async function ensureWorktrees(specs, p) {
  /** @type {WorktreeReport} */
  const report = { created: [], dirty: [], stashed: [], warnings: [] };
  /** @type {string[]} */
  const errors = [];
  /** @type {Map<string, WorktreeSpec[]>} */
  const byRepo = new Map();
  for (const spec of specs) {
    byRepo.set(spec.repo, [...(byRepo.get(spec.repo) ?? []), spec]);
  }

  for (const [repo, repoSpecs] of byRepo) {
    const { repoPath, base } = repoSpecs[0];
    const repoCommon = await commonDir(repoPath);
    const registered = await registeredWorktrees(repoPath);
    /** @type {boolean | null} null = not fetched yet */
    let baseReady = null;

    for (const spec of repoSpecs) {
      if (!isDir(spec.wtPath)) {
        if (baseReady === null) {
          baseReady = await prepareBase(repo, repoPath, base, errors);
        }
        if (!baseReady) {
          continue;
        }
        // A folder deleted by hand stays registered; only that exact path is re-added with --force (no repo-wide prune).
        const force = registered.has(comparablePath(spec.wtPath)) ? ["--force"] : [];
        const add = await git(["-C", repoPath, "worktree", "add", ...force, "--detach", spec.wtPath, `origin/${base}`]);
        if (add.ok) {
          report.created.push(spec.wtPath);
        } else {
          errors.push(`Tạo worktree ${spec.wtPath} thất bại: ${add.stderr}`);
        }
        continue;
      }
      const wtCommon = await commonDir(spec.wtPath);
      if (wtCommon === null || repoCommon === null || wtCommon !== repoCommon) {
        errors.push(
          `${spec.wtPath} đã tồn tại nhưng không phải worktree của repo ${repo}. ` +
            "Xóa thư mục đó (nếu không cần) hoặc đổi tên repo.",
        );
        continue;
      }
      await cleanDirtyWorktree(spec, report);
    }
    report.warnings.push(...(await repoWarnings(repo, repoPath, base)));
  }

  report.warnings.push(...leftoverWarnings(specs, p));
  if (errors.length > 0) {
    throw new UserError("Không chuẩn bị được worktree cho worker:", EXIT.ENVIRONMENT, errors);
  }
  return report;
}

/**
 * A worker stopped mid-task (Ctrl+C) leaves its worktree dirty, and the runner only assigns into a clean one.
 * The leftover work is stashed (recoverable, never discarded) and HEAD detached so its branch is free again.
 * @param {WorktreeSpec} spec
 * @param {WorktreeReport} report
 */
async function cleanDirtyWorktree(spec, report) {
  const status = await git(["-C", spec.wtPath, "status", "--porcelain"]);
  if (status.ok && status.stdout === "") {
    return;
  }
  const message = `mps-bridge auto-stash ${spec.workerId} ${new Date().toISOString()}`;
  const stash = status.ok ? await git(["-C", spec.wtPath, "stash", "push", "--include-untracked", "-m", message]) : status;
  if (!stash.ok) {
    report.dirty.push(spec.wtPath);
    report.warnings.push(
      `Worktree ${spec.wtPath} có thay đổi chưa commit và không tự stash được (${stash.stderr}): worker ${spec.workerId} ` +
        `sẽ báo conflict cho tới khi bạn dọn (git -C "${spec.wtPath}" status). Script không tự xóa.`,
    );
    return;
  }
  const detach = await git(["-C", spec.wtPath, "checkout", "--detach"]);
  report.stashed.push(spec.wtPath);
  report.warnings.push(
    `Worktree ${spec.wtPath} còn việc dở: đã cất vào stash "${message}" ` +
      `(xem: git -C "${spec.wtPath}" stash list).${detach.ok ? "" : ` Không detach được HEAD: ${detach.stderr}`}`,
  );
}

/**
 * M6/M7: the repo's main checkout should be a dedicated clone, and repo-level Claude settings reach the worker
 * (it runs with --setting-sources project).
 * @param {string} repo
 * @param {string} repoPath
 * @param {string} base
 * @returns {Promise<string[]>}
 */
async function repoWarnings(repo, repoPath, base) {
  const warnings = [];
  const status = await git(["-C", repoPath, "status", "--porcelain"]);
  if (status.ok && status.stdout !== "") {
    warnings.push(
      `Repo ${repo} (${repoPath}) có thay đổi chưa commit: có vẻ đây là bản clone bạn code hằng ngày. ` +
        `Nên dùng một bản clone RIÊNG cho bridge (ví dụ D:/bridge-repos/${repo}) và sửa repos[].path.`,
    );
  }
  const settingsWarning = await repoClaudeSettingsWarning(repo, repoPath, base);
  if (settingsWarning !== null) {
    warnings.push(settingsWarning);
  }
  return warnings;
}

/**
 * Warns when origin/<base>:.claude/settings.json grants permissions or installs hooks: the worker inherits them.
 * @param {string} repo
 * @param {string} repoPath
 * @param {string} base
 * @returns {Promise<string | null>}
 */
async function repoClaudeSettingsWarning(repo, repoPath, base) {
  const show = await git(["-C", repoPath, "show", `origin/${base}:${REPO_CLAUDE_SETTINGS}`]);
  if (!show.ok) {
    return null;
  }
  let risky;
  try {
    const json = JSON.parse(show.stdout);
    risky = (Array.isArray(json?.permissions?.allow) && json.permissions.allow.length > 0) || json?.hooks !== undefined;
  } catch {
    risky = /"allow"|"hooks"/.test(show.stdout);
  }
  return risky
    ? `Repo ${repo}: ${REPO_CLAUDE_SETTINGS} trên origin/${base} có "allow" hoặc "hooks". Worker nạp file này ` +
        "(--setting-sources project) nên được thêm quyền/hook đó. Kiểm tra lại nội dung file trước khi chạy."
    : null;
}

/**
 * Fetches origin/<base> and checks it exists. Pushes W01/W03 into `errors`.
 * @param {string} repo
 * @param {string} repoPath
 * @param {string} base
 * @param {string[]} errors
 * @returns {Promise<boolean>}
 */
async function prepareBase(repo, repoPath, base, errors) {
  const fetch = await git(["-C", repoPath, "fetch", "origin", base], GIT_FETCH_TIMEOUT_MS);
  if (!fetch.ok) {
    errors.push(`git fetch origin ${base} cho repo ${repo} thất bại: ${fetch.stderr}`);
    return false;
  }
  const verify = await git(["-C", repoPath, "rev-parse", "--verify", "--quiet", `refs/remotes/origin/${base}^{commit}`]);
  if (!verify.ok) {
    errors.push(`Không tìm thấy nhánh origin/${base} của repo ${repo}. Kiểm tra base_branch trong settings.json.`);
    return false;
  }
  return true;
}

/**
 * WW2: folders under worktrees/ that no slot uses any more.
 * @param {WorktreeSpec[]} specs
 * @param {WorkspacePaths} p
 * @returns {string[]}
 */
function leftoverWarnings(specs, p) {
  if (!isDir(p.worktrees)) {
    return [];
  }
  const used = new Set(specs.map((s) => comparablePath(s.wtPath)));
  // "<repo>-NN": match the whole repo name, so repo "a" does not claim the folder "a-b-01".
  const repoOf = (name) => {
    const repoName = SLOT_DIR_RE.exec(name)?.[1]?.toLowerCase();
    return specs.find((s) => s.repo.toLowerCase() === repoName)?.repoPath ?? "<đường dẫn repo>";
  };
  return readdirSync(p.worktrees, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !used.has(comparablePath(path.join(p.worktrees, d.name))))
    .map((d) => {
      const wt = path.join(p.worktrees, d.name);
      return `Worktree thừa ${wt} (không còn slot nào dùng). Có thể xóa: git -C "${repoOf(d.name)}" worktree remove "${wt}".`;
    });
}
