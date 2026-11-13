// Environment checks before anything is written: free ports, node/git/claude/uvx/npx, Claude Code flags,
// and a warm-up of mcp-atlassian so the first worker does not hit the MCP connect timeout while uvx downloads.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { APP_DEV_ENV_PREFIX, APP_DEV_SECRET_DIRS, APP_DEV_SECRET_FILES } from "./generate.mjs";
import { canonicalPath, isPathInside, samePath } from "./paths.mjs";
import { DEFAULT_PORTS, parseSettingsFile } from "./settings.mjs";
import { cleanChildEnv, run, which } from "./proc.mjs";

/** setup.mjs keeps its own copy (it checks the version before importing lib/). */
export const MIN_NODE_MAJOR = 22;
const CLAUDE_TIMEOUT_MS = 30_000;
const MCP_WARMUP_TIMEOUT_MS = 180_000;
const LOOPBACK = "127.0.0.1";
const PROBE_FILE = ".probe-missing.md";
/** Committed template (.gitignore "!.env.example"), not a secret. */
const ENV_TEMPLATE = ".env.example";
/** The backend's own config in the developer workflow (README "Cấu hình"), at the checkout root. */
const DEV_BRIDGE_CONFIG = "bridge.config.json";
const BOM = 0xfeff;

/**
 * @typedef {import("./paths.mjs").WorkspacePaths} WorkspacePaths
 * @typedef {{ name: "bridge" | "web", port: number }} NamedPort
 */

/**
 * @param {number} port
 * @returns {Promise<boolean>} true when 127.0.0.1:<port> can be bound
 */
function isPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen({ port, host: LOOPBACK, exclusive: true }, () => server.close(() => resolve(true)));
  });
}

/**
 * @param {NamedPort[]} ports
 * @returns {Promise<string[]>} P07 errors
 */
export async function checkPorts(ports) {
  const errors = [];
  for (const { name, port } of ports) {
    if (!(await isPortFree(port))) {
      errors.push(
        `Cổng ${port} (${name}) đang bị chiếm — có thể dịch vụ đang chạy ở cửa sổ khác. ` +
          `Đóng nó, hoặc đổi ports.${name} trong settings.json.`,
      );
    }
  }
  return errors;
}

/**
 * Checks the Claude Code CLI knows the flags the generated runner config passes.
 * `--append-system-prompt-file` is hidden from `claude --help`, so it is probed: with a missing file the CLI exits
 * at once with "Append system prompt file not found" (no API call), while an unknown flag prints "unknown option".
 * @param {WorkspacePaths} p
 * @returns {Promise<string[]>}
 */
async function checkClaudeFlags(p) {
  const errors = [];
  const env = cleanChildEnv();
  const help = await run("claude", ["--help"], { env, timeoutMs: CLAUDE_TIMEOUT_MS });
  if (!`${help.stdout}${help.stderr}`.includes("--setting-sources")) {
    errors.push('Claude Code quá cũ: thiếu --setting-sources. Chạy "claude update".');
  }
  mkdirSync(p.data, { recursive: true });
  const probeFile = path.join(p.data, PROBE_FILE);
  rmSync(probeFile, { force: true });
  const probe = await run(
    "claude",
    ["-p", "--append-system-prompt-file", probeFile, "--setting-sources", "project"],
    { cwd: p.data, env, timeoutMs: CLAUDE_TIMEOUT_MS },
  );
  if (probe.timedOut || /unknown option/i.test(`${probe.stdout}${probe.stderr}`)) {
    errors.push('Claude Code quá cũ: thiếu --append-system-prompt-file. Chạy "claude update".');
  }
  return errors;
}

/**
 * @param {WorkspacePaths} p
 * @param {boolean} needPnpm true when a build is needed (pnpm runs through npx)
 * @returns {Promise<string[]>} errors
 */
export async function checkTools(p, needPnpm) {
  const errors = [];
  const major = Number(process.versions.node.split(".")[0]);
  if (major < MIN_NODE_MAJOR) {
    errors.push(`Cần Node.js >= ${MIN_NODE_MAJOR} (đang chạy ${process.version}).`);
  }
  if (which("git") === null) {
    errors.push("Không tìm thấy git trong PATH. Cài Git for Windows: https://git-scm.com/download/win rồi mở lại cửa sổ.");
  }
  if (which("claude") === null) {
    errors.push('Không tìm thấy claude trong PATH. Cài Claude Code, chạy "claude" một lần để đăng nhập, rồi mở lại cửa sổ.');
  } else {
    errors.push(...(await checkClaudeFlags(p)));
  }
  if (which("uvx") === null) {
    errors.push("Không tìm thấy uvx (gói uv). Cài: winget install astral-sh.uv rồi mở lại cửa sổ.");
  }
  if (needPnpm && which("npx") === null) {
    errors.push("Không tìm thấy npx (đi kèm Node.js). Cài lại Node.js.");
  }
  return errors;
}

/**
 * `uvx mcp-atlassian --help`: downloads the package on first use. Warn-only.
 * @returns {Promise<string | null>} PW1 warning, or null when ready
 */
export async function warmUpJiraMcp() {
  let detail;
  try {
    const r = await run("uvx", ["mcp-atlassian", "--help"], { env: cleanChildEnv(), timeoutMs: MCP_WARMUP_TIMEOUT_MS });
    if (r.code === 0 && !r.timedOut) {
      return null;
    }
    const lastLine = r.stderr.trim().split(/\r?\n/).pop() ?? "";
    detail = r.timedOut ? `quá ${MCP_WARMUP_TIMEOUT_MS / 1000} giây` : lastLine || `mã thoát ${r.code}`;
  } catch (err) {
    detail = /** @type {Error} */ (err).message;
  }
  return `Không chuẩn bị được mcp-atlassian (${detail}). Jira trong Claude có thể lỗi lần đầu; kiểm tra mạng/proxy rồi chạy lại.`;
}

/**
 * Ports for `update`, which must work even when settings.json is half-filled. Any problem → defaults.
 * @param {string} settingsFile
 * @returns {{ bridge: number, web: number }}
 */
export function readPortsLoosely(settingsFile) {
  const out = { ...DEFAULT_PORTS };
  const parsed = parseSettingsFile(settingsFile);
  if (!parsed.ok || typeof parsed.raw !== "object" || parsed.raw === null) {
    return out;
  }
  const ports = /** @type {Record<string, unknown>} */ (parsed.raw).ports;
  if (typeof ports !== "object" || ports === null) {
    return out;
  }
  for (const name of /** @type {const} */ (["bridge", "web"])) {
    const v = /** @type {Record<string, unknown>} */ (ports)[name];
    if (Number.isInteger(v) && /** @type {number} */ (v) > 0 && /** @type {number} */ (v) <= 65535) {
      out[name] = /** @type {number} */ (v);
    }
  }
  return out;
}

/**
 * The Jira env file (it holds the PAT) named by the developer-workflow config <appRoot>\bridge.config.json, when it
 * lies inside the checkout; null when the config is missing, unreadable or not valid JSON, has no jira_env_file, or
 * points outside. A relative value is resolved against the config file's folder, as the backend's loadConfig does.
 * @param {string} appRoot
 * @returns {string | null} absolute path (the file itself may not exist)
 */
export function appJiraEnvFile(appRoot) {
  let config;
  try {
    const text = readFileSync(path.join(appRoot, DEV_BRIDGE_CONFIG), "utf8");
    config = JSON.parse(text.charCodeAt(0) === BOM ? text.slice(1) : text);
  } catch {
    // Missing or broken dev config: nothing to protect, and not this tool's business to report.
    return null;
  }
  const value = config?.jira_env_file;
  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }
  const file = path.resolve(appRoot, value);
  return isPathInside(canonicalPath(appRoot), canonicalPath(file)) ? file : null;
}

/**
 * Developer-workflow secrets found in the bridge checkout. Workers are denied them (generate.mjs), but in the default
 * layout they run below the checkout, and the deny rules are only a second line of defence.
 * @param {string} appRoot
 * @returns {string | null} warning
 */
export function appDevSecretsWarning(appRoot) {
  const found = [...APP_DEV_SECRET_FILES, ...APP_DEV_SECRET_DIRS]
    .map((rel) => path.join(appRoot, rel))
    .filter((p) => existsSync(p));
  /** @type {string[]} */
  let names = [];
  try {
    names = readdirSync(appRoot);
  } catch {
    // Unreadable checkout: the build check reports it.
  }
  for (const name of names) {
    if (name.startsWith(APP_DEV_ENV_PREFIX) && name !== ENV_TEMPLATE) {
      found.push(path.join(appRoot, name));
    }
  }
  const jiraEnvFile = appJiraEnvFile(appRoot);
  if (jiraEnvFile !== null && existsSync(jiraEnvFile) && !found.some((f) => samePath(f, jiraEnvFile))) {
    found.push(jiraEnvFile);
  }
  if (found.length === 0) {
    return null;
  }
  return (
    `Bản clone bridge ${appRoot} có file cấu hình/bí mật của chế độ dev (${found.join(", ")}). Worker chạy bên dưới ` +
    "bản clone này và chỉ bị chặn đọc chúng bằng danh sách lệnh cấm. Nên dùng một bản clone RIÊNG để chạy bridge, " +
    "hoặc xóa/chuyển các file đó ra ngoài."
  );
}
