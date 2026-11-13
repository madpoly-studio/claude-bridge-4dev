// One detached git worktree per worker slot. Creates missing ones, stashes leftover work in dirty ones (never deletes
// or resets), and warns about setups that weaken the worker sandbox or break it: stale worktrees in an old location,
// paths near the Windows limit, a JS repo below the bridge checkout, CLAUDE.md files above the worktrees.
import { readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { EXIT, UserError } from "./errors.mjs";
import { canonicalPath, isPathInside } from "./paths.mjs";
import { cleanChildEnv, run } from "./proc.mjs";

/** Characters: MAX_PATH (260) minus a margin for build outputs that are not in git (Unity Library\, obj\). */
export const LONG_PATH_WARN = 240;
const GIT_TIMEOUT_MS = 30_000;
const GIT_FETCH_TIMEOUT_MS = 180_000;
const REPO_CLAUDE_SETTINGS = ".claude/settings.json";
const SLOT_DIR_RE = /^(.+)-(\d{2,})$/;
const BRANCH_REF_PREFIX = "refs/heads/";
/** Files Claude Code loads as project instructions from the working directory and every parent. */
const CLAUDE_MD_FILES = Object.freeze(["CLAUDE.md", "CLAUDE.local.md", path.join(".claude", "CLAUDE.md")]);

/**
 * @typedef {import("./generate.mjs").WorktreeSpec} WorktreeSpec
 * @typedef {import("./paths.mjs").WorkspacePaths} WorkspacePaths
 * @typedef {{ created: string[], dirty: string[], stashed: string[], warnings: string[] }} WorktreeReport
 */

/**
 * A worktree git has registered for a repo. `path` is for display, `key` for comparisons; `branch` is "feature/x"
 * for "branch refs/heads/feature/x", null when detached.
 * @typedef {{ path: string, key: string, prunable: boolean, branch: string | null }} RegisteredWorktree
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
 * false also when the path cannot be read (ancestor folders of other users): a warning check must never throw.
 * @param {string} p
 */
function isFile(p) {
  try {
    return statSync(p, { throwIfNoEntry: false })?.isFile() ?? false;
  } catch {
    return false;
  }
}

/**
 * Worktrees git has registered for `repoPath`, without the repo's own checkout.
 * @param {string} repoPath
 * @returns {Promise<RegisteredWorktree[]>}
 */
async function registeredWorktrees(repoPath) {
  const r = await git(["-C", repoPath, "worktree", "list", "--porcelain"]);
  const mainKey = comparablePath(repoPath);
  /** @type {RegisteredWorktree[]} */
  const list = [];
  // Porcelain: one block per worktree, blocks separated by an empty line, "worktree <path>" first.
  for (const block of r.stdout.split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/);
    const head = lines.find((line) => line.startsWith("worktree "));
    if (head === undefined) {
      continue;
    }
    const wtPath = path.resolve(head.slice("worktree ".length));
    const key = comparablePath(wtPath);
    if (key === mainKey) {
      continue;
    }
    const ref = lines.find((line) => line.startsWith("branch "))?.slice("branch ".length) ?? null;
    list.push({
      path: wtPath,
      key,
      prunable: lines.some((line) => line === "prunable" || line.startsWith("prunable ")),
      branch: ref === null ? null : ref.replace(BRANCH_REF_PREFIX, ""),
    });
  }
  return list;
}

/**
 * @param {WorktreeSpec[]} specs
 * @param {WorkspacePaths} p effective paths: p.worktrees is the current worktrees root
 * @param {{ longPathLimit?: number }} [options] test seam for the long-path threshold
 * @returns {Promise<WorktreeReport>}
 */
export async function ensureWorktrees(specs, p, options = {}) {
  const longPathLimit = options.longPathLimit ?? LONG_PATH_WARN;
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
    const registeredKeys = new Set(registered.map((w) => w.key));
    /** @type {boolean | null} null = not fetched yet */
    let baseReady = null;
    // The checkout checks (long paths, package.json) run only when a worktree was (re)created, so a warning appears
    // once per change instead of on every start, and ls-tree on a large repo is not paid each time.
    let addAttempted = false;

    for (const spec of repoSpecs) {
      if (!isDir(spec.wtPath)) {
        if (baseReady === null) {
          baseReady = await prepareBase(repo, repoPath, base, errors);
        }
        if (!baseReady) {
          continue;
        }
        addAttempted = true;
        // A folder deleted by hand stays registered; only that exact path is re-added with --force (no repo-wide prune).
        const force = registeredKeys.has(comparablePath(spec.wtPath)) ? ["--force"] : [];
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
    report.warnings.push(...staleLocationWarnings(repo, repoPath, registered, specs, p.worktrees));
    if (addAttempted) {
      report.warnings.push(...(await checkoutWarnings(repo, repoSpecs, p, longPathLimit)));
    }
  }

  report.warnings.push(...leftoverWarnings(specs, p));
  report.warnings.push(...ancestorClaudeMdWarnings([p.worktrees, p.root]));
  if (errors.length > 0) {
    // The warnings go with the error: a long-path hint matters most when the add failed with "Filename too long".
    const warningDetails = report.warnings.map((w) => `[CẢNH BÁO] ${w}`);
    throw new UserError("Không chuẩn bị được worktree cho worker:", EXIT.ENVIRONMENT, [...errors, ...warningDetails]);
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

/** @param {string} s */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * WW3: slot worktrees of `repo` that git still has registered but that are not current slots, either outside the
 * current worktrees root (worktrees_dir changed, bridge moved) or with their folder deleted. Either can hold a branch
 * a worker needs. Existing folders under the current root are leftoverWarnings' job. Never touches git.
 * @param {string} repo
 * @param {string} repoPath
 * @param {RegisteredWorktree[]} registered
 * @param {WorktreeSpec[]} specs
 * @param {string} worktreesRoot
 * @returns {string[]}
 */
function staleLocationWarnings(repo, repoPath, registered, specs, worktreesRoot) {
  const slotRe = new RegExp(`^${escapeRegExp(repo)}-\\d{2,}$`, "i");
  const current = new Set(specs.map((s) => comparablePath(s.wtPath)));
  const rootKey = comparablePath(worktreesRoot);
  return registered
    .filter((wt) => slotRe.test(path.basename(wt.path)) && !current.has(wt.key))
    .filter((wt) => wt.prunable || comparablePath(path.dirname(wt.path)) !== rootKey)
    .map((wt) => {
      const branchNote =
        wt.branch === null ? "" : ` Nó đang giữ nhánh ${wt.branch}: worker nào cần nhánh này sẽ lỗi "already checked out".`;
      if (wt.prunable) {
        return `Repo ${repo} còn đăng ký worktree ${wt.path} nhưng thư mục đã bị xóa.${branchNote} ` +
          `Dọn bằng: git -C "${repoPath}" worktree prune.`;
      }
      return (
        `Worktree cũ ${wt.path} của repo ${repo} nằm ngoài thư mục worktree hiện tại ${worktreesRoot} ` +
        `(đã đổi worktrees_dir hoặc chuyển chỗ cài bridge?).${branchNote} Kiểm tra không còn việc dở ` +
        `(git -C "${wt.path}" status) rồi xóa: git -C "${repoPath}" worktree remove "${wt.path}". Script không tự xóa.`
      );
    });
}

/**
 * WW4 (Windows) and WW6 (worktrees inside the bridge checkout), from one ls-tree of origin/<base>. Nothing when
 * neither applies or ls-tree fails/times out.
 * @param {string} repo
 * @param {WorktreeSpec[]} repoSpecs
 * @param {WorkspacePaths} p
 * @param {number} longPathLimit
 * @returns {Promise<string[]>}
 */
async function checkoutWarnings(repo, repoSpecs, p, longPathLimit) {
  const isWindows = process.platform === "win32";
  const insideApp = isPathInside(canonicalPath(p.app), canonicalPath(p.worktrees));
  if (!isWindows && !insideApp) {
    return [];
  }
  const { repoPath, base } = repoSpecs[0];
  const r = await git(["-C", repoPath, "ls-tree", "-r", "--name-only", "-z", `origin/${base}`]);
  if (!r.ok) {
    return [];
  }
  const files = r.stdout.split("\0").filter((name) => name !== "");
  const warnings = [];
  if (isWindows) {
    const longestWt = repoSpecs.map((s) => s.wtPath).reduce((a, b) => (b.length > a.length ? b : a));
    const longPath = longPathWarning(repo, files, longestWt, longPathLimit);
    if (longPath !== null) {
      warnings.push(longPath);
    }
  }
  if (insideApp && files.some((name) => path.posix.basename(name) === "package.json")) {
    warnings.push(
      `Repo ${repo} có package.json, còn worktree của worker nằm trong bản clone bridge ${p.app}: Node/pnpm trong ` +
        "worktree tìm lên thư mục cha và sẽ thấy node_modules và pnpm-workspace.yaml của bridge. Đặt worktrees_dir " +
        "trong settings.json ra ngoài bản clone (ví dụ D:/wt).",
    );
  }
  return warnings;
}

/**
 * WW4: the longest tracked file checked out under `wtPath` would come close to MAX_PATH.
 * @param {string} repo
 * @param {string[]} files tracked paths of origin/<base>
 * @param {string} wtPath the longest worktree path of the repo's slots
 * @param {number} limit
 * @returns {string | null}
 */
function longPathWarning(repo, files, wtPath, limit) {
  let longest = "";
  for (const name of files) {
    if (name.length > longest.length) {
      longest = name;
    }
  }
  const total = wtPath.length + 1 + longest.length;
  if (longest === "" || total <= limit) {
    return null;
  }
  return (
    `Repo ${repo}: đường dẫn file dài nhất trong worktree sẽ là ${total} ký tự (${path.join(wtPath, longest)}), ` +
    'sát giới hạn 260 ký tự của Windows; checkout/build (Unity, MSBuild) có thể lỗi "Filename too long". ' +
    "Đặt worktrees_dir trong settings.json sang một thư mục ngắn (ví dụ D:/wt) và chạy git config --global core.longpaths true."
  );
}

/**
 * WW5: one warning per CLAUDE.md, CLAUDE.local.md or .claude\CLAUDE.md in each start dir and every ancestor (dirs
 * deduped). Workers (--setting-sources project) and orchestrators (setting_sources ["project"], generate.mjs) do not
 * load the user's own settings or memory, but they do load these files from every parent folder as project
 * instructions. That includes <home>\.claude\CLAUDE.md when the home folder is a parent, so it is reported too; when
 * it is not a parent, the walk never reaches it. That file gets its own message: it is personal and must not be
 * deleted; the bridge has to move out of the home folder instead.
 * @param {string[]} startDirs
 * @param {string} [homeDir] test seam; default os.homedir()
 * @returns {string[]}
 */
export function ancestorClaudeMdWarnings(startDirs, homeDir = os.homedir()) {
  const userMemoryKey = comparablePath(path.join(homeDir, ".claude", "CLAUDE.md"));
  /** @type {Set<string>} */
  const seenDirs = new Set();
  /** @type {string[]} */
  const warnings = [];
  for (const start of startDirs) {
    let dir = path.resolve(start);
    for (;;) {
      const dirKey = comparablePath(dir);
      if (seenDirs.has(dirKey)) {
        break;
      }
      seenDirs.add(dirKey);
      for (const name of CLAUDE_MD_FILES) {
        const file = path.join(dir, name);
        if (!isFile(file)) {
          continue;
        }
        if (comparablePath(file) === userMemoryKey) {
          // The user's personal memory: the fix is moving the bridge out of the home folder, never deleting it.
          warnings.push(
            `${file} là file hướng dẫn cá nhân của bạn, nhưng bản clone bridge / thư mục làm việc (và worktrees_dir) ` +
              `đang nằm trong thư mục người dùng ${homeDir}: Claude Code nạp file này cho MỌI worker và orchestrator ` +
              `như hướng dẫn của dự án. Đừng xóa file đó; hãy chuyển bản clone bridge (và worktrees_dir) ra ngoài ` +
              `${homeDir}, ví dụ D:/claude-bridge.`,
          );
        } else {
          warnings.push(
            `${file} nằm ở thư mục cha của worktree/thư mục làm việc: Claude Code nạp file này cho MỌI worker và ` +
              "orchestrator như hướng dẫn của dự án. Di chuyển/xóa nó, hoặc đặt bridge (và worktrees_dir) ở chỗ " +
              "không có CLAUDE.md phía trên.",
          );
        }
      }
      const parent = path.dirname(dir);
      if (parent === dir) {
        break;
      }
      dir = parent;
    }
  }
  return warnings;
}

/**
 * WW2: slot folders ("<repo>-NN") under the worktrees root that no slot uses any more.
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
    .filter((d) => d.isDirectory() && SLOT_DIR_RE.test(d.name) && !used.has(comparablePath(path.join(p.worktrees, d.name))))
    .map((d) => {
      const wt = path.join(p.worktrees, d.name);
      return `Worktree thừa ${wt} (không còn slot nào dùng). Có thể xóa: git -C "${repoOf(d.name)}" worktree remove "${wt}".`;
    });
}
