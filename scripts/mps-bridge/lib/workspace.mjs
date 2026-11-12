// Workspace IO: init (folders, settings template, pairing token, launchers) and the wipe + rewrite of generated/.
import { randomBytes } from "node:crypto";
import { constants as fsConstants, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { EXIT, UserError } from "./errors.mjs";
import { isPathInside } from "./paths.mjs";

/** 24 bytes → 32 base64url characters (the backend requires at least 16). */
const PAIRING_TOKEN_BYTES = 24;
const PAIRING_TOKEN_RE = /^[A-Za-z0-9_-]{16,}$/;
const BOM = String.fromCharCode(0xfeff);
const SETTINGS_TEMPLATE = "settings.template.json";
const GUIDE_TEMPLATE = "HUONG-DAN.txt";
const LAUNCHERS = Object.freeze(["start.cmd", "update.cmd"]);
const LOG_NAME_RE = /^[a-z]+-(\d{4})(\d{2})(\d{2})\.log$/;
const DAY_MS = 86_400_000;

/**
 * @typedef {import("./paths.mjs").WorkspacePaths} WorkspacePaths
 * @typedef {import("./generate.mjs").WorkspaceFiles} WorkspaceFiles
 */

/** @param {string} text */
function toCrlf(text) {
  return text.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n");
}

/**
 * @param {WorkspacePaths} p
 * @param {string} name
 */
function readTemplate(p, name) {
  const file = path.join(p.templatesDir, name);
  try {
    return readFileSync(file, "utf8");
  } catch (err) {
    throw new UserError(`Thiếu file mẫu ${file} (${/** @type {Error} */ (err).message}). Chạy lại setup.`, EXIT.ENVIRONMENT);
  }
}

/**
 * Creates the folder layout, settings.json (only if missing), the pairing token (only if missing) and the launchers.
 * @param {WorkspacePaths} p
 * @returns {{ createdSettings: boolean, createdToken: boolean }}
 */
export function initWorkspace(p) {
  for (const dir of [p.app, p.generatedMcp, p.generatedFlow, p.data, p.orchestrators, p.worktrees, p.logs]) {
    mkdirSync(dir, { recursive: true });
  }
  const template = path.join(p.templatesDir, SETTINGS_TEMPLATE);
  if (!existsSync(template)) {
    throw new UserError(`Thiếu file mẫu ${template}. Chạy lại setup.`, EXIT.ENVIRONMENT);
  }
  let createdSettings = true;
  try {
    // COPYFILE_EXCL: never overwrite the user's settings, even if it appeared after an existence check.
    copyFileSync(template, p.settings, fsConstants.COPYFILE_EXCL);
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code !== "EEXIST") {
      throw err;
    }
    createdSettings = false;
  }
  const createdToken = !existsSync(p.pairingTokenFile);
  readOrCreatePairingToken(p);
  writeLaunchers(p);
  return { createdSettings, createdToken };
}

/**
 * The pairing token is created once and kept, so "Ghi nhớ trên máy này" in the web UI survives restarts.
 * @param {WorkspacePaths} p
 * @returns {string}
 */
export function readOrCreatePairingToken(p) {
  if (existsSync(p.pairingTokenFile)) {
    const token = readFileSync(p.pairingTokenFile, "utf8").trim();
    if (!PAIRING_TOKEN_RE.test(token)) {
      throw new UserError(
        `${p.pairingTokenFile} bị hỏng (cần ít nhất 16 ký tự A-Z a-z 0-9 _ -). Xóa file đó để tạo token mới rồi chạy lại.`,
        EXIT.ENVIRONMENT,
      );
    }
    return token;
  }
  mkdirSync(p.data, { recursive: true });
  const token = randomBytes(PAIRING_TOKEN_BYTES).toString("base64url");
  writeFileSync(p.pairingTokenFile, `${token}\n`, { encoding: "utf8", flag: "wx" });
  return token;
}

/**
 * Writes `content` only when it differs from what is on disk. update.cmd is executing while `update` refreshes the
 * launchers, and cmd.exe reads a batch file by offset: an unchanged file must not be touched.
 * @param {string} file
 * @param {Buffer} content
 */
function writeIfChanged(file, content) {
  const current = existsSync(file) ? readFileSync(file) : null;
  if (current === null || !current.equals(content)) {
    writeFileSync(file, content);
  }
}

/**
 * start.cmd / update.cmd (CRLF, ASCII only, no BOM) and HUONG-DAN.txt (UTF-8 with BOM, CRLF), rewritten when changed.
 * @param {WorkspacePaths} p
 */
export function writeLaunchers(p) {
  for (const name of LAUNCHERS) {
    const text = toCrlf(readTemplate(p, name));
    if (!/^[\x00-\x7f]*$/.test(text)) {
      throw new UserError(`File mẫu ${name} chứa ký tự không phải ASCII: cmd.exe sẽ đọc sai. Báo người bảo trì.`, EXIT.ENVIRONMENT);
    }
    writeIfChanged(path.join(p.root, name), Buffer.from(text, "ascii"));
  }
  const guide = readTemplate(p, GUIDE_TEMPLATE).split("{{WORKSPACE}}").join(p.root);
  writeIfChanged(p.guide, Buffer.from(BOM + toCrlf(guide.startsWith(BOM) ? guide.slice(1) : guide), "utf8"));
}

/**
 * Deletes generated/ and writes every derived file again. Hand edits there are lost by design.
 * @param {WorkspacePaths} p
 * @param {WorkspaceFiles} files
 */
export function writeGenerated(p, files) {
  if (!isPathInside(p.root, p.generated) || path.resolve(p.generated) === path.resolve(p.root)) {
    throw new Error(`refusing to wipe ${p.generated}: not below the workspace ${p.root}`);
  }
  rmSync(p.generated, { recursive: true, force: true, maxRetries: 3 });
  mkdirSync(p.generatedMcp, { recursive: true });
  mkdirSync(p.generatedFlow, { recursive: true });
  const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
  writeFileSync(p.bridgeConfig, json(files.bridgeConfig), "utf8");
  writeFileSync(p.runnerConfig, json(files.runnerConfig), "utf8");
  writeFileSync(p.teamEnv, files.teamEnv, "utf8");
  writeFileSync(p.workerMcp, json(files.mcpJira), "utf8");
  for (const [repo, markdown] of Object.entries(files.workerFlows)) {
    writeFileSync(path.join(p.generatedFlow, `${repo}.md`), markdown, "utf8");
  }
  for (const dir of files.dirs) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * @param {WorkspacePaths} p
 * @returns {string[]} the build outputs (and the vite binary) that are absent
 */
export function distMissing(p) {
  return [p.protocolEntry, p.backendEntry, p.runnerEntry, p.webDistIndex, p.viteBin].filter((f) => !existsSync(f));
}

/**
 * Deletes `logs/<name>-YYYYMMDD.log` files dated more than `maxAgeDays` days before `now`. Other files are kept.
 * @param {WorkspacePaths} p
 * @param {number} maxAgeDays
 * @param {Date} [now]
 * @returns {string[]} deleted file names
 */
export function pruneLogs(p, maxAgeDays, now = new Date()) {
  if (!existsSync(p.logs)) {
    return [];
  }
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const deleted = [];
  for (const name of readdirSync(p.logs)) {
    const m = LOG_NAME_RE.exec(name);
    if (m === null) {
      continue;
    }
    const day = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
    if (today - day > maxAgeDays * DAY_MS) {
      try {
        unlinkSync(path.join(p.logs, name));
        deleted.push(name);
      } catch {
        // Still open in another process or already gone: try again next start.
      }
    }
  }
  return deleted;
}
