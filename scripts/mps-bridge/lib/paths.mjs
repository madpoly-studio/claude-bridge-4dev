// Workspace layout: every well-known path under the workspace root, plus symlink-safe path containment.
import { realpathSync } from "node:fs";
import path from "node:path";

export const DEFAULT_WORKSPACE = "D:/mps-claude-bridge";
export const APP_REPO_URL = "https://github.com/madpoly-studio/claude-bridge-4dev.git";
export const APP_BRANCH = "main";

const IS_WINDOWS = process.platform === "win32";
const WORKER_NUMBER_WIDTH = 2;

/**
 * @param {string | undefined} flag value of --workspace
 * @returns {string} absolute workspace root
 */
export function resolveWorkspace(flag) {
  return path.resolve(flag ?? DEFAULT_WORKSPACE);
}

/**
 * @typedef {object} WorkspacePaths
 * @property {string} root
 * @property {string} app
 * @property {string} settings
 * @property {string} startCmd
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
 * @property {string} worktrees
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
 * @returns {WorkspacePaths}
 */
export function workspacePaths(root) {
  const j = (...parts) => path.join(root, ...parts);
  const app = j("app");
  const generated = j("generated");
  const data = j("data");
  const webDir = path.join(app, "packages", "web");
  return {
    root,
    app,
    settings: j("settings.json"),
    startCmd: j("start.cmd"),
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
