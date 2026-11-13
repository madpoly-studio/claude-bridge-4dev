// settings.json: parse (BOM, line/col errors, `_*` guidance keys stripped) and validate into a normalised Settings object.
// Every problem is collected in one pass; nothing here throws on bad input, touches git or writes files.
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { jsonErrorMessage } from "./json-error.mjs";
import { APP_ROOT, WORKSPACE_DIR_NAME, canonicalPath, isPathInside, workspacePaths } from "./paths.mjs";

/** A template value the user still has to replace, e.g. "<JIRA_PERSONAL_TOKEN>". */
export const PLACEHOLDER_RE = /<[A-Z][A-Z0-9_]*>/;

/** Bridge port the web UI connects to by default (packages/web/src/config.ts). */
export const WEB_UI_DEFAULT_BRIDGE_PORT = 8787;
export const DEFAULT_PORTS = Object.freeze({ bridge: WEB_UI_DEFAULT_BRIDGE_PORT, web: 4173 });
const MIN_PORT = 1024;
const MAX_PORT = 65535;
const BOM = 0xfeff;

const ROOT_KEYS = ["jira", "projects", "repos", "models", "ports", "max_concurrency", "worktrees_dir"];
const JIRA_KEYS = ["url", "personal_token", "ca_bundle"];
const REPO_KEYS = ["name", "path", "project_key", "base_branch", "workers", "allowed_bash"];
const MODEL_KEYS = ["planner", "orchestrator", "worker"];
const PORT_KEYS = ["bridge", "web"];

const PROJECT_KEY_RE = /^[A-Z][A-Z0-9_]+$/;
const REPO_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

const KIND = Object.freeze({
  STRING: "chuỗi",
  INT: "số nguyên",
  LIST: "danh sách [...]",
  OBJECT: "object {...}",
  STRING_OR_NULL: "chuỗi hoặc null",
});

/**
 * @typedef {object} RepoSettings
 * @property {string} name
 * @property {string} path absolute, normalised
 * @property {string} project_key
 * @property {string} base_branch
 * @property {number} workers
 * @property {string[]} allowed_bash
 */

/**
 * @typedef {object} Settings
 * @property {{ url: string, personal_token: string, ca_bundle: string | null }} jira
 * @property {string[]} projects
 * @property {RepoSettings[]} repos
 * @property {{ planner: string | null, orchestrator: string | null, worker: string | null }} models
 * @property {{ bridge: number, web: number }} ports
 * @property {number} max_concurrency
 * @property {string | null} worktrees_dir absolute, path.resolve'd; null = <workspace>\worktrees
 */

/**
 * @typedef {object} FsProbe
 * @property {(p: string) => boolean} isDir
 * @property {(p: string) => boolean} isFile
 * @property {(p: string) => boolean} exists
 * @property {(p: string) => string} canonical
 */

/**
 * @typedef {object} ValidationContext
 * @property {string} workspace absolute workspace root
 * @property {string} appRoot bridge checkout root (required: tests pass a fake one)
 * @property {FsProbe} fs
 */

/** @typedef {{ ok: true, raw: unknown } | { ok: false, error: string }} ParseResult */
/** @typedef {{ errors: string[], warnings: string[], settings: Settings | null }} ValidationResult */

/** @type {FsProbe} */
export const realFs = {
  isDir: (p) => statSync(p, { throwIfNoEntry: false })?.isDirectory() ?? false,
  isFile: (p) => statSync(p, { throwIfNoEntry: false })?.isFile() ?? false,
  exists: (p) => existsSync(p),
  canonical: (p) => canonicalPath(p),
};

/** @param {unknown} v */
function isPlainObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Removes every key starting with "_" at any depth (guidance text in the template).
 * @param {unknown} value
 * @returns {unknown}
 */
function stripGuidance(value) {
  if (Array.isArray(value)) {
    return value.map(stripGuidance);
  }
  if (isPlainObject(value)) {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [key, v] of Object.entries(/** @type {Record<string, unknown>} */ (value))) {
      if (!key.startsWith("_")) {
        out[key] = stripGuidance(v);
      }
    }
    return out;
  }
  return value;
}

/**
 * @param {string} text
 * @returns {ParseResult}
 */
export function parseSettingsText(text) {
  const body = text.charCodeAt(0) === BOM ? text.slice(1) : text;
  let raw;
  try {
    raw = JSON.parse(body);
  } catch (err) {
    return { ok: false, error: jsonErrorMessage(body, /** @type {Error} */ (err).message) };
  }
  return { ok: true, raw: stripGuidance(raw) };
}

/**
 * @param {string} file
 * @returns {ParseResult}
 */
export function parseSettingsFile(file) {
  if (!existsSync(file)) {
    return { ok: false, error: missingSettingsMessage(file) };
  }
  return parseSettingsText(readFileSync(file, "utf8"));
}

/** S00. @param {string} file */
export function missingSettingsMessage(file) {
  const setup = path.join(APP_ROOT, "scripts", "mps-bridge", "setup.mjs");
  return `Không tìm thấy ${file}. Chạy setup để tạo: node "${setup}" --workspace "${path.dirname(file)}"`;
}

/** @param {string} p */
function isAbsoluteLocal(p) {
  if (!path.isAbsolute(p)) {
    return false;
  }
  // On Windows "/repos/x" is drive-relative: require a drive letter or a UNC prefix.
  return process.platform !== "win32" || /^([A-Za-z]:[\\/]|[\\/]{2})/.test(p);
}

/** @param {string} branch */
function isValidBranch(branch) {
  return BRANCH_RE.test(branch) && !branch.includes("..") && !branch.endsWith(".lock") && !branch.endsWith("/");
}

/**
 * Collects errors with their JSON path. One instance per validateSettings call.
 */
class Collector {
  constructor() {
    /** @type {string[]} */
    this.errors = [];
  }

  /** @param {string} jsonPath @param {string} message */
  add(jsonPath, message) {
    this.errors.push(jsonPath === "" ? message : `${jsonPath}: ${message}`);
  }

  /**
   * S03 for every key not in `allowed`.
   * @param {Record<string, unknown>} obj
   * @param {string[]} allowed
   * @param {string} prefix
   */
  unknownKeys(obj, allowed, prefix) {
    for (const key of Object.keys(obj)) {
      if (!allowed.includes(key)) {
        const keyPath = prefix === "" ? key : `${prefix}.${key}`;
        this.add(keyPath, `Khóa "${key}" không được hỗ trợ (gõ nhầm?). Khóa hợp lệ: ${allowed.join(", ")}.`);
      }
    }
  }

  /**
   * Required non-empty string: S05 missing, S04 placeholder, S06 wrong type.
   * @param {unknown} value
   * @param {string} jsonPath
   * @returns {string | undefined} trimmed value, undefined when an error was reported
   */
  requiredString(value, jsonPath) {
    if (value === undefined || value === null || (typeof value === "string" && value.trim() === "")) {
      this.add(jsonPath, "Thiếu giá trị bắt buộc.");
      return undefined;
    }
    if (typeof value !== "string") {
      this.add(jsonPath, `Phải là ${KIND.STRING}.`);
      return undefined;
    }
    return this.notPlaceholder(value.trim(), jsonPath);
  }

  /**
   * @param {string} value
   * @param {string} jsonPath
   * @returns {string | undefined}
   */
  notPlaceholder(value, jsonPath) {
    if (PLACEHOLDER_RE.test(value)) {
      this.add(jsonPath, `Còn giá trị mẫu "${value}" — hãy thay bằng giá trị thật.`);
      return undefined;
    }
    return value;
  }

  /**
   * Optional section: undefined/null → `{}`; anything but an object → S06.
   * @param {unknown} value
   * @param {string} jsonPath
   * @param {string[]} allowed
   * @returns {Record<string, unknown> | undefined}
   */
  optionalSection(value, jsonPath, allowed) {
    if (value === undefined || value === null) {
      return {};
    }
    if (!isPlainObject(value)) {
      this.add(jsonPath, `Phải là ${KIND.OBJECT}.`);
      return undefined;
    }
    const obj = /** @type {Record<string, unknown>} */ (value);
    this.unknownKeys(obj, allowed, jsonPath);
    return obj;
  }
}

/**
 * @param {Collector} c
 * @param {unknown} value
 * @param {FsProbe} fs
 */
function validateJira(c, value, fs) {
  if (value === undefined || value === null) {
    c.add("jira", "Thiếu giá trị bắt buộc.");
    return undefined;
  }
  if (!isPlainObject(value)) {
    c.add("jira", `Phải là ${KIND.OBJECT}.`);
    return undefined;
  }
  const jira = /** @type {Record<string, unknown>} */ (value);
  c.unknownKeys(jira, JIRA_KEYS, "jira");

  let url = c.requiredString(jira.url, "jira.url");
  if (url !== undefined) {
    let parsed = null;
    try {
      parsed = new URL(url);
    } catch {
      parsed = null;
    }
    if (parsed === null || (parsed.protocol !== "https:" && parsed.protocol !== "http:")) {
      c.add("jira.url", "Phải là URL http(s) hợp lệ, ví dụ https://jira-mps.mto.zing.vn.");
      url = undefined;
    } else {
      url = url.replace(/\/+$/, "");
    }
  }

  let token = c.requiredString(jira.personal_token, "jira.personal_token");
  if (token !== undefined && /\s/.test(token)) {
    c.add("jira.personal_token", "Token không được chứa khoảng trắng hoặc xuống dòng.");
    token = undefined;
  }

  /** @type {string | null | undefined} */
  let caBundle = null;
  const ca = jira.ca_bundle;
  if (typeof ca === "string" && ca.trim() !== "") {
    caBundle = c.notPlaceholder(ca.trim(), "jira.ca_bundle");
    if (caBundle !== undefined) {
      if (!isAbsoluteLocal(caBundle)) {
        c.add("jira.ca_bundle", "Phải là đường dẫn tuyệt đối (ví dụ D:/certs/corp.pem).");
        caBundle = undefined;
      } else {
        caBundle = path.resolve(caBundle);
        if (!fs.isFile(caBundle)) {
          c.add("jira.ca_bundle", `Không tìm thấy file "${caBundle}".`);
          caBundle = undefined;
        }
      }
    }
  } else if (ca !== undefined && ca !== null && typeof ca !== "string") {
    c.add("jira.ca_bundle", `Phải là ${KIND.STRING_OR_NULL}.`);
    caBundle = undefined;
  }

  if (url === undefined || token === undefined || caBundle === undefined) {
    return undefined;
  }
  return { url, personal_token: token, ca_bundle: caBundle };
}

/**
 * @param {Collector} c
 * @param {unknown} value
 * @returns {{ valid: string[], mentioned: string[] }} valid keys, and every string given (for repos[].project_key)
 */
function validateProjects(c, value) {
  /** @type {string[]} */
  const valid = [];
  /** @type {string[]} */
  const mentioned = [];
  if (value === undefined || value === null) {
    c.add("projects", "Thiếu giá trị bắt buộc.");
    return { valid, mentioned };
  }
  if (!Array.isArray(value)) {
    c.add("projects", `Phải là ${KIND.LIST}.`);
    return { valid, mentioned };
  }
  if (value.length === 0) {
    c.add("projects", "Cần ít nhất một Jira project key.");
    return { valid, mentioned };
  }
  value.forEach((item, i) => {
    const itemPath = `projects[${i}]`;
    if (typeof item !== "string") {
      c.add(itemPath, `Phải là ${KIND.STRING}.`);
      return;
    }
    const key = c.notPlaceholder(item.trim(), itemPath);
    if (key === undefined) {
      return;
    }
    mentioned.push(key);
    if (!PROJECT_KEY_RE.test(key)) {
      c.add(itemPath, `"${key}" không đúng dạng project key (chữ in hoa/số/_, bắt đầu bằng chữ, ít nhất 2 ký tự, ví dụ SH).`);
    } else if (valid.includes(key)) {
      c.add(itemPath, `"${key}" bị lặp.`);
    } else {
      valid.push(key);
    }
  });
  return { valid, mentioned };
}

/**
 * @param {Collector} c
 * @param {unknown} value
 * @param {string} repoPath JSON path of the repo
 * @param {ValidationContext} ctx
 * @returns {string | undefined}
 */
function validateRepoPath(c, value, repoPath, ctx) {
  const jsonPath = `${repoPath}.path`;
  const given = c.requiredString(value, jsonPath);
  if (given === undefined) {
    return undefined;
  }
  if (!isAbsoluteLocal(given)) {
    c.add(jsonPath, "Phải là đường dẫn tuyệt đối (ví dụ D:/repos/sh-game).");
    return undefined;
  }
  const resolved = path.resolve(given);
  const repoCanonical = ctx.fs.canonical(resolved);
  const wsCanonical = ctx.fs.canonical(ctx.workspace);
  if (isPathInside(wsCanonical, repoCanonical)) {
    c.add(jsonPath, `Repo nằm bên trong thư mục làm việc ${ctx.workspace}. Đặt repo ở chỗ khác.`);
    return undefined;
  }
  if (isPathInside(repoCanonical, wsCanonical)) {
    c.add(jsonPath, `Thư mục làm việc ${ctx.workspace} nằm bên trong repo này; chọn repo khác hoặc clone bridge ra ngoài repo.`);
    return undefined;
  }
  const appCanonical = ctx.fs.canonical(ctx.appRoot);
  if (isPathInside(appCanonical, repoCanonical)) {
    c.add(jsonPath, `Repo nằm bên trong mã nguồn bridge ${ctx.appRoot}. Dùng một bản clone riêng đặt ở chỗ khác.`);
    return undefined;
  }
  if (isPathInside(repoCanonical, appCanonical)) {
    c.add(jsonPath, `Mã nguồn bridge ${ctx.appRoot} nằm bên trong repo này; clone bridge ra ngoài repo rồi chạy lại setup.`);
    return undefined;
  }
  if (!ctx.fs.isDir(resolved)) {
    c.add(jsonPath, `Không tìm thấy thư mục "${resolved}".`);
    return undefined;
  }
  if (!ctx.fs.exists(path.join(resolved, ".git"))) {
    c.add(jsonPath, `"${resolved}" không phải git repo (không có .git). Clone repo về trước.`);
    return undefined;
  }
  return resolved;
}

/**
 * @param {Collector} c
 * @param {unknown} value
 * @param {string} repoPath
 * @returns {string[] | undefined}
 */
function validateAllowedBash(c, value, repoPath) {
  const jsonPath = `${repoPath}.allowed_bash`;
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    c.add(jsonPath, `Phải là ${KIND.LIST}.`);
    return undefined;
  }
  /** @type {string[]} */
  const out = [];
  let ok = true;
  value.forEach((item, k) => {
    const itemPath = `${jsonPath}[${k}]`;
    if (typeof item !== "string" || item.trim() === "") {
      c.add(itemPath, 'Phải là chuỗi lệnh không rỗng, ví dụ "npm test".');
      ok = false;
      return;
    }
    const command = c.notPlaceholder(item.trim(), itemPath);
    if (command === undefined) {
      ok = false;
      return;
    }
    out.push(command);
  });
  return ok ? out : undefined;
}

/**
 * @param {Collector} c
 * @param {unknown} value
 * @param {string[]} projectKeys every project key string the user listed
 * @param {ValidationContext} ctx
 * @returns {RepoSettings[] | undefined}
 */
function validateRepos(c, value, projectKeys, ctx) {
  if (value === undefined || value === null) {
    c.add("repos", "Thiếu giá trị bắt buộc.");
    return undefined;
  }
  if (!Array.isArray(value)) {
    c.add("repos", `Phải là ${KIND.LIST}.`);
    return undefined;
  }
  if (value.length === 0) {
    c.add("repos", "Cần ít nhất một repo.");
    return undefined;
  }
  /** @type {RepoSettings[]} */
  const repos = [];
  /** @type {Map<string, number>} lower-case name → first index */
  const seenNames = new Map();
  let ok = true;
  value.forEach((item, i) => {
    const repoPath = `repos[${i}]`;
    if (!isPlainObject(item)) {
      c.add(repoPath, `Phải là ${KIND.OBJECT}.`);
      ok = false;
      return;
    }
    const repo = /** @type {Record<string, unknown>} */ (item);
    const before = c.errors.length;
    c.unknownKeys(repo, REPO_KEYS, repoPath);

    const name = c.requiredString(repo.name, `${repoPath}.name`);
    if (name !== undefined) {
      if (!REPO_NAME_RE.test(name)) {
        c.add(`${repoPath}.name`, `"${name}" chỉ được chứa chữ, số, . _ - (tối đa 40 ký tự, bắt đầu bằng chữ/số).`);
      } else {
        const first = seenNames.get(name.toLowerCase());
        if (first !== undefined) {
          c.add(`${repoPath}.name`, `"${name}" trùng với repos[${first}] (không phân biệt hoa thường).`);
        } else {
          seenNames.set(name.toLowerCase(), i);
        }
      }
    }

    const resolvedPath = validateRepoPath(c, repo.path, repoPath, ctx);

    const projectKey = c.requiredString(repo.project_key, `${repoPath}.project_key`);
    if (projectKey !== undefined && !projectKeys.includes(projectKey)) {
      c.add(`${repoPath}.project_key`, `"${projectKey}" không có trong projects.`);
    }

    const base = c.requiredString(repo.base_branch, `${repoPath}.base_branch`);
    if (base !== undefined && !isValidBranch(base)) {
      c.add(`${repoPath}.base_branch`, `"${base}" không phải tên nhánh hợp lệ (ví dụ develop, main, release/1.2).`);
    }

    let workers = 1;
    if (repo.workers !== undefined && repo.workers !== null) {
      if (!Number.isInteger(repo.workers) || /** @type {number} */ (repo.workers) < 1) {
        c.add(`${repoPath}.workers`, "Phải là số nguyên ≥ 1.");
      } else {
        workers = /** @type {number} */ (repo.workers);
      }
    }

    const allowedBash = validateAllowedBash(c, repo.allowed_bash, repoPath);

    if (c.errors.length !== before) {
      ok = false;
      return;
    }
    repos.push({
      name: /** @type {string} */ (name),
      path: /** @type {string} */ (resolvedPath),
      project_key: /** @type {string} */ (projectKey),
      base_branch: /** @type {string} */ (base),
      workers,
      allowed_bash: /** @type {string[]} */ (allowedBash),
    });
  });
  return ok ? repos : undefined;
}

/**
 * @param {Collector} c
 * @param {unknown} value
 */
function validateModels(c, value) {
  const models = c.optionalSection(value, "models", MODEL_KEYS);
  /** @type {{ planner: string | null, orchestrator: string | null, worker: string | null }} */
  const out = { planner: null, orchestrator: null, worker: null };
  if (models === undefined) {
    return undefined;
  }
  let ok = true;
  for (const role of MODEL_KEYS) {
    const v = models[role];
    if (v === undefined || v === null) {
      continue;
    }
    if (typeof v !== "string" || v.trim() === "") {
      c.add(`models.${role}`, "Phải là tên model (chuỗi) hoặc null.");
      ok = false;
      continue;
    }
    const model = c.notPlaceholder(v.trim(), `models.${role}`);
    if (model === undefined) {
      ok = false;
      continue;
    }
    out[/** @type {"planner" | "orchestrator" | "worker"} */ (role)] = model;
  }
  return ok ? out : undefined;
}

/**
 * @param {Collector} c
 * @param {unknown} value
 */
function validatePorts(c, value) {
  const ports = c.optionalSection(value, "ports", PORT_KEYS);
  if (ports === undefined) {
    return undefined;
  }
  const out = { ...DEFAULT_PORTS };
  let ok = true;
  for (const name of PORT_KEYS) {
    const v = ports[name];
    if (v === undefined || v === null) {
      continue;
    }
    if (!Number.isInteger(v) || /** @type {number} */ (v) < MIN_PORT || /** @type {number} */ (v) > MAX_PORT) {
      c.add(`ports.${name}`, `Phải là số nguyên từ ${MIN_PORT} đến ${MAX_PORT}.`);
      ok = false;
      continue;
    }
    out[/** @type {"bridge" | "web"} */ (name)] = /** @type {number} */ (v);
  }
  if (ok && out.bridge === out.web) {
    c.add("ports", "bridge và web không được trùng cổng.");
    ok = false;
  }
  return ok ? out : undefined;
}

/**
 * S04/S06/S60-S67: optional folder for the worker worktrees. It must stay out of every folder the bridge or git owns:
 * the workspace and the checkout (S62/S63 equal or ancestor), the folders start wipes or holds secrets in (S64), the
 * checkout outside its gitignored ws\ (S65, else update.cmd refuses a dirty clone), and the repos (S66/S67, skipped
 * when repos is invalid). First failure wins, like validateRepoPath.
 * @param {Collector} c
 * @param {unknown} value
 * @param {RepoSettings[] | undefined} repos
 * @param {ValidationContext} ctx
 * @returns {string | null | undefined} null = default, undefined = error reported
 */
function validateWorktreesDir(c, value, repos, ctx) {
  const jsonPath = "worktrees_dir";
  if (value === undefined || value === null || (typeof value === "string" && value.trim() === "")) {
    return null;
  }
  if (typeof value !== "string") {
    c.add(jsonPath, `Phải là ${KIND.STRING_OR_NULL}.`);
    return undefined;
  }
  const given = c.notPlaceholder(value.trim(), jsonPath);
  if (given === undefined) {
    return undefined;
  }
  if (!isAbsoluteLocal(given)) {
    c.add(jsonPath, "Phải là đường dẫn tuyệt đối (ví dụ D:/wt).");
    return undefined;
  }
  const resolved = path.resolve(given);
  if (ctx.fs.exists(resolved) && !ctx.fs.isDir(resolved)) {
    c.add(jsonPath, `"${resolved}" đã tồn tại nhưng không phải thư mục.`);
    return undefined;
  }
  const wt = ctx.fs.canonical(resolved);
  const ws = ctx.fs.canonical(ctx.workspace);
  const app = ctx.fs.canonical(ctx.appRoot);
  if (isPathInside(wt, ws)) {
    c.add(jsonPath, `Không được trùng hoặc chứa thư mục làm việc ${ctx.workspace}. Chọn một thư mục riêng, ví dụ D:/wt.`);
    return undefined;
  }
  if (isPathInside(wt, app)) {
    c.add(jsonPath, `Không được trùng hoặc chứa mã nguồn bridge ${ctx.appRoot}. Chọn một thư mục riêng, ví dụ D:/wt.`);
    return undefined;
  }
  const p = workspacePaths(ctx.workspace, ctx.appRoot);
  const managedDir = [p.generated, p.data, p.logs, p.orchestrators].find((d) => isPathInside(ctx.fs.canonical(d), wt));
  if (managedDir !== undefined) {
    c.add(
      jsonPath,
      `Không được nằm trong ${managedDir}: thư mục này do bridge tự quản lý (generated bị xóa và ghi lại mỗi lần start).`,
    );
    return undefined;
  }
  const appWs = path.join(ctx.appRoot, WORKSPACE_DIR_NAME);
  if (isPathInside(app, wt) && !isPathInside(ctx.fs.canonical(appWs), wt)) {
    c.add(
      jsonPath,
      `Nằm trong mã nguồn bridge ${ctx.appRoot}: bản clone sẽ có thay đổi chưa commit và update.cmd sẽ từ chối cập nhật. ` +
        `Đặt ở ngoài (ví dụ D:/wt) hoặc trong ${appWs}.`,
    );
    return undefined;
  }
  for (const repo of repos ?? []) {
    const repoCanonical = ctx.fs.canonical(repo.path);
    if (isPathInside(repoCanonical, wt)) {
      c.add(jsonPath, `Nằm bên trong repo ${repo.name} (${repo.path}). Worktree của worker phải ở ngoài mọi repo.`);
      return undefined;
    }
    if (isPathInside(wt, repoCanonical)) {
      c.add(jsonPath, `Chứa repo ${repo.name} (${repo.path}). Chọn thư mục không chứa repo nào.`);
      return undefined;
    }
  }
  return resolved;
}

/**
 * @param {unknown} raw parsed settings with `_*` keys already stripped
 * @param {ValidationContext} ctx
 * @returns {ValidationResult}
 */
export function validateSettings(raw, ctx) {
  const c = new Collector();
  /** @type {string[]} */
  const warnings = [];
  if (!isPlainObject(raw)) {
    c.add("", "Nội dung gốc phải là một object { ... }.");
    return { errors: c.errors, warnings, settings: null };
  }
  const root = /** @type {Record<string, unknown>} */ (raw);
  c.unknownKeys(root, ROOT_KEYS, "");

  const jira = validateJira(c, root.jira, ctx.fs);
  const projects = validateProjects(c, root.projects);
  const repos = validateRepos(c, root.repos, projects.mentioned, ctx);
  const models = validateModels(c, root.models);
  const ports = validatePorts(c, root.ports);

  let maxConcurrency = null;
  const mc = root.max_concurrency;
  if (mc !== undefined && mc !== null) {
    if (!Number.isInteger(mc) || /** @type {number} */ (mc) < 1) {
      c.add("max_concurrency", "Phải là số nguyên ≥ 1 hoặc null.");
    } else {
      maxConcurrency = /** @type {number} */ (mc);
    }
  }

  const worktreesDir = validateWorktreesDir(c, root.worktrees_dir, repos, ctx);

  if (c.errors.length > 0 || !jira || !repos || !models || !ports || worktreesDir === undefined) {
    return { errors: c.errors, warnings, settings: null };
  }

  for (const key of projects.valid) {
    if (!repos.some((r) => r.project_key === key)) {
      warnings.push(`Project ${key} chưa có repo nào: orchestrator của nó sẽ không có worker để giao việc.`);
    }
  }
  if (ports.bridge !== WEB_UI_DEFAULT_BRIDGE_PORT) {
    warnings.push(
      `ports.bridge = ${ports.bridge} khác ${WEB_UI_DEFAULT_BRIDGE_PORT}: ` +
        `lần đầu hãy nhập ws://127.0.0.1:${ports.bridge}/ws ở màn hình Kết nối.`,
    );
  }

  return {
    errors: [],
    warnings,
    settings: {
      jira,
      projects: projects.valid,
      repos,
      models,
      ports,
      max_concurrency: maxConcurrency ?? repos.reduce((sum, r) => sum + r.workers, 0),
      worktrees_dir: worktreesDir,
    },
  };
}
