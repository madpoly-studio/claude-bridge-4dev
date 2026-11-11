// Turns `claude_command + args` into something child_process.spawn can run without `shell: true`.
// On Windows `claude` may be a native .exe (installer) or a .cmd shim (npm global). A .cmd can only run
// through cmd.exe, so for that case every argument is escaped for cmd.exe instead of handing a raw
// command line to a shell.
import { execFile } from "node:child_process";
import path from "node:path";

export interface SpawnPlan {
  file: string;
  args: string[];
  /** true when `args` is a pre-escaped cmd.exe command line. */
  windowsVerbatimArguments: boolean;
}

const NATIVE_EXTENSIONS = new Set([".exe", ".com"]);
const BATCH_EXTENSIONS = new Set([".cmd", ".bat"]);
const WHERE_TIMEOUT_MS = 10_000;

const whereCache = new Map<string, string | null>();

export async function planSpawn(
  command: readonly string[],
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
): Promise<SpawnPlan> {
  const [head, ...prefixArgs] = command;
  if (!head) {
    throw new Error("claude_command is empty");
  }
  const allArgs = [...prefixArgs, ...args];
  if (platform !== "win32") {
    return { file: head, args: allArgs, windowsVerbatimArguments: false };
  }

  let file = head;
  const ext = path.extname(head).toLowerCase();
  const bareName = ext === "" && !/[\\/]/.test(head);
  if (bareName) {
    // Plain spawn("claude") only finds claude.exe; resolve through PATH/PATHEXT like a shell would.
    file = (await whereOnWindows(head)) ?? head;
  }
  if (BATCH_EXTENSIONS.has(path.extname(file).toLowerCase())) {
    return planCmdShim(file, allArgs);
  }
  return { file, args: allArgs, windowsVerbatimArguments: false };
}

/** First `where` hit that is directly spawnable (.exe/.com), else the first .cmd/.bat; null when none. */
async function whereOnWindows(name: string): Promise<string | null> {
  const cached = whereCache.get(name);
  if (cached !== undefined) {
    return cached;
  }
  const hits = await new Promise<string[]>((resolve) => {
    execFile("where.exe", [name], { timeout: WHERE_TIMEOUT_MS, windowsHide: true }, (err, stdout) => {
      resolve(err ? [] : String(stdout).split(/\r?\n/).map((l) => l.trim()).filter(Boolean));
    });
  });
  const native = hits.find((p) => NATIVE_EXTENSIONS.has(path.extname(p).toLowerCase()));
  const batch = hits.find((p) => BATCH_EXTENSIONS.has(path.extname(p).toLowerCase()));
  const resolved = native ?? batch ?? null;
  if (resolved) {
    whereCache.set(name, resolved);
  }
  return resolved;
}

// cmd.exe metacharacters (same set as the widely used cross-spawn package).
const CMD_META_CHARS = /([()\][%!^"`<>&|;, *?])/g;

function escapeCmdCommand(command: string): string {
  return command.replace(CMD_META_CHARS, "^$1");
}

/**
 * Quote for the MSVCRT argv parser, then caret-escape cmd metacharacters. Batch shims re-expand `%*`,
 * so their arguments need the caret escaping applied twice.
 */
export function escapeCmdArgument(arg: string, doubleEscape: boolean): string {
  let out = arg.replace(/(\\*)"/g, '$1$1\\"');
  out = out.replace(/(\\*)$/, "$1$1");
  out = `"${out}"`;
  out = out.replace(CMD_META_CHARS, "^$1");
  if (doubleEscape) {
    out = out.replace(CMD_META_CHARS, "^$1");
  }
  return out;
}

function planCmdShim(shimPath: string, args: string[]): SpawnPlan {
  const line = [escapeCmdCommand(path.normalize(shimPath)), ...args.map((a) => escapeCmdArgument(a, true))].join(" ");
  return {
    file: process.env.ComSpec ?? process.env.COMSPEC ?? "cmd.exe",
    args: ["/d", "/s", "/c", `"${line}"`],
    windowsVerbatimArguments: true,
  };
}
