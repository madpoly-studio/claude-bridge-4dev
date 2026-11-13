// Workspace layout: the bridge checkout (APP_ROOT), every well-known path under the workspace root, and symlink-safe
// path containment.
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EXIT, UserError } from "./errors.mjs";

/** The bridge checkout this file lives in (<clone>\scripts\mps-bridge\lib\paths.mjs). No trailing separator. */
export const APP_ROOT = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));
/** Default workspace folder under APP_ROOT. Must match the anchored "/ws/" line in .gitignore. */
export const WORKSPACE_DIR_NAME = "ws";
export const APP_BRANCH = "main";

const IS_WINDOWS = process.platform === "win32";
const WORKER_NUMBER_WIDTH = 2;

/**
 * @param {string | undefined} flag value of --workspace
 * @returns {string} absolute workspace root (default <APP_ROOT>\ws)
 */
export function resolveWorkspace(flag) {
  return path.resolve(flag ?? path.join(APP_ROOT, WORKSPACE_DIR_NAME));
}

/**
 * A workspace inside the checkout is only allowed under <appRoot>\ws (gitignored): anywhere else settings.json and the
 * Jira token become untracked files of the bridge repo (update.cmd refuses, "git clean" deletes them). A workspace
 * that holds the checkout (an install made before ws\ existed) is fine.
 * @param {string} root absolute workspace root
 * @param {string} [appRoot]
 */
export function assertWorkspaceLocation(root, appRoot = APP_ROOT) {
  const ws = canonicalPath(root);
  const defaultWs = path.join(appRoot, WORKSPACE_DIR_NAME);
  if (isPathInside(canonicalPath(appRoot), ws) && !isPathInside(canonicalPath(defaultWs), ws)) {
    throw new UserError(
      `Thư mục làm việc ${root} nằm trong mã nguồn bridge ${appRoot} nhưng ngoài ${defaultWs}: settings.json và Jira ` +
        `token sẽ thành file chưa commit trong bản clone (update.cmd từ chối cập nhật, git clean xóa mất). ` +
        `Bỏ --workspace để dùng ${defaultWs}, hoặc chọn thư mục ngoài bản clone.`,
      EXIT.ENVIRONMENT,
    );
  }
}

/**
 * The workspace of an install made before ws\ existed (checkout at <old workspace>\app, launchers next to it), or
 * null. Only the parent of `appRoot` is looked at.
 * @param {string} [appRoot]
 * @returns {string | null}
 */
export function oldInstallWorkspace(appRoot = APP_ROOT) {
  const parent = path.dirname(appRoot);
  const looksInstalled = existsSync(path.join(parent, "settings.json")) && existsSync(path.join(parent, "start.cmd"));
  return parent !== appRoot && looksInstalled ? parent : null;
}

/**
 * @typedef {object} WorkspacePaths
 * @property {string} root
 * @property {string} app bridge checkout root
 * @property {string} settings
 * @property {string} startCmd
 * @property {string} prepareCmd
 * @property {string} updateCmd
 * @property {string} guide
 * @property {string} generated
 * @property {string} generatedMcp
 * @property {string} generatedFlow
 * @property {string} bridgeConfig
 * @property {string} runnerConfig
 * @property {string} teamEnv
 * @property {string} workerMcp
 * @property {string} data
 * @property {string} pairingTokenFile
 * @property {string} runnerBootstrapTokenFile
 * @property {string} orchestrators
 * @property {string} worktrees default <root>\worktrees; the effective root after `withWorktreesRoot` (cmdStart)
 * @property {string} logs
 * @property {string} cliEntry
 * @property {string} templatesDir
 * @property {string} backendEntry
 * @property {string} runnerEntry
 * @property {string} protocolEntry
 * @property {string} webDistIndex
 * @property {string} webDir
 * @property {string} viteBin
 */

/**
 * @param {string} root absolute workspace root
 * @param {string} [appRoot] bridge checkout; source of app, cliEntry, templatesDir, *Entry, webDistIndex, webDir, viteBin
 * @returns {WorkspacePaths}
 */
export function workspacePaths(root, appRoot = APP_ROOT) {
  const j = (...parts) => path.join(root, ...parts);
  const app = appRoot;
  const generated = j("generated");
  const data = j("data");
  const webDir = path.join(app, "packages", "web");
  return {
    root,
    app,
    settings: j("settings.json"),
    startCmd: j("start.cmd"),
    prepareCmd: j("prepare.cmd"),
    updateCmd: j("update.cmd"),
    guide: j("HUONG-DAN.txt"),
    generated,
    generatedMcp: path.join(generated, "mcp"),
    generatedFlow: path.join(generated, "worker-flow"),
    bridgeConfig: path.join(generated, "bridge.config.json"),
    runnerConfig: path.join(generated, "runner.config.json"),
    teamEnv: path.join(generated, "team-jira.env"),
    workerMcp: path.join(generated, "mcp", "worker-jira.json"),
    data,
    pairingTokenFile: path.join(data, "pairing-token.txt"),
    runnerBootstrapTokenFile: path.join(data, "runner-bootstrap.token"),
    orchestrators: j("orchestrators"),
    worktrees: j("worktrees"),
    logs: j("logs"),
    cliEntry: path.join(app, "scripts", "mps-bridge", "cli.mjs"),
    templatesDir: path.join(app, "scripts", "mps-bridge", "templates"),
    backendEntry: path.join(app, "packages", "backend", "dist", "index.js"),
    runnerEntry: path.join(app, "packages", "runner", "dist", "index.js"),
    protocolEntry: path.join(app, "packages", "protocol", "dist", "index.js"),
    webDistIndex: path.join(webDir, "dist", "index.html"),
    webDir,
    viteBin: path.join(webDir, "node_modules", "vite", "bin", "vite.js"),
  };
}

/**
 * Effective paths for start: `p` with `worktrees` replaced when `dir` (the validated settings.worktrees_dir) is set.
 * @param {WorkspacePaths} p
 * @param {string | null} dir
 * @returns {WorkspacePaths}
 */
export function withWorktreesRoot(p, dir) {
  return dir === null ? p : { ...p, worktrees: dir };
}

/**
 * @param {string} repo
 * @param {number} n 1-based slot number
 */
export function workerId(repo, n) {
  return `w-${repo}-${String(n).padStart(WORKER_NUMBER_WIDTH, "0")}`;
}

/**
 * @param {WorkspacePaths} p
 * @param {string} repo
 * @param {number} n 1-based slot number
 */
export function worktreePath(p, repo, n) {
  return path.join(p.worktrees, `${repo}-${String(n).padStart(WORKER_NUMBER_WIDTH, "0")}`);
}

/**
 * Absolute, symlink-free form of `p`. A path that does not exist yet is resolved through its nearest existing
 * ancestor. Copied on purpose from packages/backend/src/util/paths.ts (the scripts run before anything is built).
 * @param {string} p
 * @returns {string}
 */
export function canonicalPath(p) {
  const abs = path.resolve(p);
  const missing = [];
  let current = abs;
  for (;;) {
    try {
      const real = realpathSync.native(current);
      return missing.length === 0 ? real : path.join(real, ...missing.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        return abs;
      }
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

/** @param {string} p */
function comparable(p) {
  const trimmed = p.length > 1 && p.endsWith(path.sep) && !/^[A-Za-z]:\\$/.test(p) ? p.slice(0, -1) : p;
  return IS_WINDOWS ? trimmed.toLowerCase() : trimmed;
}

/**
 * true when `target` is `root` itself or below it. Both should already be canonical (see `canonicalPath`).
 * @param {string} root
 * @param {string} target
 */
export function isPathInside(root, target) {
  const r = comparable(root);
  const t = comparable(target);
  if (t === r) {
    return true;
  }
  return t.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
}

/**
 * true when `a` and `b` name the same location. Both should already be canonical (case-insensitive on Windows).
 * @param {string} a
 * @param {string} b
 */
export function samePath(a, b) {
  return isPathInside(a, b) && isPathInside(b, a);
}
