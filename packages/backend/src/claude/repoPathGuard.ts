// Read-only sandbox for the planner (system design §12): every path a built-in tool touches must resolve inside the
// session's repository, and secret-looking files are never read. Runs inside the PreToolUse hook, which the CLI calls for
// every tool call — unlike canUseTool, which in-cwd reads never reach and whose `blockedPath` the CLI may leave unset.
import { basename, isAbsolute, resolve } from "node:path";
import { canonicalPath, isPathInside } from "../util/paths.js";

const MCP_PREFIX = "mcp__";

/** Input fields of built-in tools that name a file or directory to read. */
const PATH_FIELDS = ["file_path", "path", "notebook_path"] as const;
/** Glob-like input fields (Glob `pattern`, Grep `glob`) evaluated relative to the search root. */
const GLOB_FIELDS: Record<string, readonly string[]> = { Glob: ["pattern"], Grep: ["glob"] };

/** Basenames (lower case) of files that commonly hold credentials. */
const SECRET_FILE_PATTERNS: readonly RegExp[] = [
  /^\.env$/,
  /^\.env\..+$/,
  /\.pem$/,
  /\.key$/,
  /^id_(rsa|dsa|ecdsa|ed25519)/,
  /^\.npmrc$/,
  /^[._]netrc$/,
  /^\.git-credentials$/,
  /^credentials/,
];

/**
 * Permission rules for `Options.disallowedTools`: the CLI applies Read deny rules to Read, Grep and Glob, so a
 * repo-wide Grep does not print a matching line from a `.env`. Defence in depth next to the hook.
 */
export const SECRET_READ_DENY_RULES: readonly string[] = [
  "Read(**/.env)",
  "Read(**/.env.*)",
  "Read(**/*.pem)",
  "Read(**/*.key)",
  "Read(**/id_rsa*)",
  "Read(**/id_dsa*)",
  "Read(**/id_ecdsa*)",
  "Read(**/id_ed25519*)",
  "Read(**/.npmrc)",
  "Read(**/.netrc)",
  "Read(**/_netrc)",
  "Read(**/.git-credentials)",
  "Read(**/credentials*)",
];

export function isSecretFileName(name: string): boolean {
  const lower = name.toLowerCase();
  return SECRET_FILE_PATTERNS.some((re) => re.test(lower));
}

export class RepoPathGuard {
  private readonly root: string;

  constructor(private readonly cwd: string) {
    this.root = canonicalPath(cwd);
  }

  /** Reason to deny the call, or null when every path in the input stays inside the repo and is not a secret. */
  check(toolName: string, input: unknown): string | null {
    if (toolName.startsWith(MCP_PREFIX)) return null;
    const fields = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
    const paths: string[] = [];
    for (const key of PATH_FIELDS) {
      const value = fields[key];
      if (value === undefined || value === null || value === "") continue;
      if (typeof value !== "string") return `${toolName}: ${key} must be a string`;
      paths.push(value);
    }
    // Grep / Glob without `path` search the session cwd, which is the repo root itself.
    for (const p of paths) {
      const reason = this.checkPath(p);
      if (reason) return `${toolName}: ${reason}`;
    }
    for (const key of GLOB_FIELDS[toolName] ?? []) {
      const value = fields[key];
      if (typeof value === "string" && escapesSearchRoot(value)) {
        return `${toolName}: ${key} "${value}" must be relative and must not contain ".." or "~"`;
      }
    }
    return null;
  }

  private checkPath(raw: string): string | null {
    if (hasExpansionSyntax(raw)) return `path "${raw}" uses ~, $ or % expansion, which is not allowed`;
    if (process.platform === "win32" && hasAlternateStream(raw)) return `path "${raw}" names an alternate data stream`;
    const target = canonicalPath(resolve(this.cwd, raw));
    if (!isPathInside(this.root, target)) return `path ${raw} is outside this session's repository`;
    if (isSecretFileName(basename(raw)) || isSecretFileName(basename(target))) {
      return `path ${raw} looks like a secret file and cannot be read in a planner session`;
    }
    return null;
  }
}

/** `~` (home), `$VAR` / `${VAR}` and `%VAR%` may be expanded by the tool after the hook has checked the literal path. */
function hasExpansionSyntax(p: string): boolean {
  return p.startsWith("~") || p.includes("$") || p.includes("%");
}

/** `file.txt:stream` / `.env::$DATA`; the drive letter colon (`D:`) is fine. */
function hasAlternateStream(p: string): boolean {
  const withoutDrive = /^[A-Za-z]:/.test(p) ? p.slice(2) : p;
  return withoutDrive.includes(":");
}

function escapesSearchRoot(pattern: string): boolean {
  if (isAbsolute(pattern) || /^[A-Za-z]:/.test(pattern) || pattern.startsWith("~")) return true;
  return pattern.split(/[\\/]/).includes("..");
}
