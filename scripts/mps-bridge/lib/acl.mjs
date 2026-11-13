// Windows ACL for the workspace (it holds the Jira PAT): only the current user, SYSTEM and Administrators.
import { execFile } from "node:child_process";
import path from "node:path";

const SYSTEM_SID = "S-1-5-18";
const ADMINISTRATORS_SID = "S-1-5-32-544";
const TOOL_TIMEOUT_MS = 60_000;
const SID_RE = /S-1-[0-9-]+/;
/** icacls marks inherited entries with "(I)" in every locale. */
const INHERITED_MARK = "(I)";

/**
 * Absolute System32 path: a Git-for-Windows PATH puts a coreutils `whoami` ahead of the Windows one.
 * @param {string} exe
 */
function system32(exe) {
  return path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", exe);
}

/**
 * @param {string} file
 * @param {string[]} args
 * @returns {Promise<{ ok: boolean, stdout: string, error: string }>}
 */
function exec(file, args) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: TOOL_TIMEOUT_MS, windowsHide: true, encoding: "utf8" }, (err, stdout, stderr) => {
      resolve({ ok: err === null, stdout: String(stdout), error: err === null ? "" : String(stderr).trim() || err.message });
    });
  });
}

/**
 * Removes inherited permissions from `root` and grants full control to the current user, SYSTEM and Administrators
 * (inherited by everything below). Skipped when `root` already has no inherited entry, so re-running init does not
 * re-propagate through worktrees\. Applied to the workspace only, never to a custom worktrees_dir (a shared folder
 * the user chose; no secret lives there). Windows only; never throws.
 * @param {string} root
 * @returns {Promise<string | null>} a Vietnamese warning, or null when the ACL is in place
 */
export async function lockDownWorkspaceAcl(root) {
  if (process.platform !== "win32") {
    return null;
  }
  const current = await exec(system32("icacls.exe"), [root]);
  if (current.ok && !current.stdout.includes(INHERITED_MARK)) {
    return null;
  }
  const who = await exec(system32("whoami.exe"), ["/user", "/fo", "csv", "/nh"]);
  const sid = SID_RE.exec(who.stdout)?.[0];
  if (!who.ok || sid === undefined) {
    const reason = who.error || "whoami không trả về SID";
    return `Không xác định được tài khoản Windows hiện tại (${reason}); chưa khóa quyền truy cập ${root}.`;
  }
  const grant = (s) => `*${s}:(OI)(CI)F`;
  const r = await exec(system32("icacls.exe"), [root, "/inheritance:r", "/grant:r", grant(sid), grant(SYSTEM_SID), grant(ADMINISTRATORS_SID)]);
  if (!r.ok) {
    return `Không khóa được quyền truy cập ${root} (${r.error}). Thư mục chứa Jira token: đừng chia sẻ máy/thư mục này.`;
  }
  return null;
}
