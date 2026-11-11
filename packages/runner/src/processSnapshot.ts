// win32: process-table snapshots and the bookkeeping that finds claude's descendants in them.
// Windows does not reparent orphans and `taskkill /T` cannot find them once their parent is gone, so the
// runner records descendants while claude runs and re-checks them after it exits (see orphanReaper.ts).
import { execFile } from "node:child_process";

export interface ProcessEntry {
  pid: number;
  ppid: number;
  /** Creation time as a FILETIME (100 ns ticks since 1601-01-01 UTC). Tells a process apart from a later one reusing its pid. */
  created: bigint;
}

/** One line per process: "<pid> <ppid> <creation FILETIME>". FILETIME keeps full precision (JSON dates would round to ms). */
const SNAPSHOT_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate | ForEach-Object {",
  "  $c = if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc() } else { 0 }",
  '  "$($_.ProcessId) $($_.ParentProcessId) $c"',
  "}",
].join("\n");
/** -EncodedCommand (UTF-16LE base64) sidesteps command-line quoting of the script. */
const SNAPSHOT_ENCODED = Buffer.from(SNAPSHOT_SCRIPT, "utf16le").toString("base64");
const SNAPSHOT_TIMEOUT_MS = 10_000;
const SNAPSHOT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const SNAPSHOT_LINE = /^(\d+) (\d+) (\d+)$/;

/** Milliseconds between 1601-01-01 (FILETIME epoch) and 1970-01-01 (Unix epoch). */
const FILETIME_EPOCH_OFFSET_MS = 11_644_473_600_000n;
const FILETIME_TICKS_PER_MS = 10_000n;

/** Runs PowerShell (Get-CimInstance Win32_Process) once; about 0.5 s on a dev machine. Rejects on failure or timeout. */
export function takeProcessSnapshot(): Promise<ProcessEntry[]> {
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", SNAPSHOT_ENCODED],
      { timeout: SNAPSHOT_TIMEOUT_MS, maxBuffer: SNAPSHOT_MAX_OUTPUT_BYTES, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`process snapshot failed: ${String(stderr).trim() || err.message}`));
          return;
        }
        resolve(parseProcessSnapshot(String(stdout)));
      },
    );
  });
}

export function parseProcessSnapshot(text: string): ProcessEntry[] {
  const entries: ProcessEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = SNAPSHOT_LINE.exec(line.trim());
    if (match) {
      entries.push({ pid: Number(match[1]), ppid: Number(match[2]), created: BigInt(match[3]!) });
    }
  }
  return entries;
}

export function fileTimeFromMs(unixMs: number): bigint {
  return (BigInt(Math.floor(unixMs)) + FILETIME_EPOCH_OFFSET_MS) * FILETIME_TICKS_PER_MS;
}

/**
 * Descendants of one root process, accumulated over successive snapshots. A process counts as a child of
 * a known process when its ppid matches and it was created after that parent, and not after the parent's
 * pid was taken over by a newer process. Known processes that have left the table are dropped, so the
 * set only ever holds live descendants (verified by pid + creation time on every snapshot).
 */
export class DescendantSet {
  private readonly known = new Map<string, ProcessEntry>();

  constructor(private readonly root: Omit<ProcessEntry, "ppid">) {}

  record(snapshot: readonly ProcessEntry[]): void {
    const byPid = new Map<number, ProcessEntry>();
    const childrenOf = new Map<number, ProcessEntry[]>();
    for (const entry of snapshot) {
      byPid.set(entry.pid, entry);
      if (entry.pid !== entry.ppid) {
        const siblings = childrenOf.get(entry.ppid);
        if (siblings) {
          siblings.push(entry);
        } else {
          childrenOf.set(entry.ppid, [entry]);
        }
      }
    }

    // Known processes no longer in the table are gone; their children (if alive) are in the table and reached below.
    const parents: Array<Omit<ProcessEntry, "ppid">> = [this.root, ...this.known.values()];
    for (const [key, entry] of this.known) {
      if (byPid.get(entry.pid)?.created !== entry.created) {
        this.known.delete(key);
      }
    }
    while (parents.length > 0) {
      const parent = parents.pop()!;
      const holder = byPid.get(parent.pid);
      const reusedAt = holder && holder.created > parent.created ? holder.created : null;
      for (const child of childrenOf.get(parent.pid) ?? []) {
        const createdUnderParent = child.created >= parent.created && (reusedAt === null || child.created < reusedAt);
        const key = entryKey(child);
        if (!createdUnderParent || this.known.has(key) || (child.pid === this.root.pid && child.created === this.root.created)) {
          continue;
        }
        this.known.set(key, child);
        parents.push(child);
      }
    }
  }

  /** Live descendants as of the last `record()`. */
  descendants(): ProcessEntry[] {
    return [...this.known.values()];
  }
}

function entryKey(entry: ProcessEntry): string {
  return `${entry.pid}:${entry.created}`;
}
