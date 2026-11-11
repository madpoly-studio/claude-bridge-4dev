// MCP server config for a Claude process, written to a private temp file (system design §12): the Agent SDK turns
// `Options.mcpServers` into `--mcp-config <json>` on the CLI command line, where any local process can read the bus
// bearer token and `env` secrets (Jira PAT). A file path in argv exposes nothing.
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";

const FILE_NAME = "mcp-config.json";
/** Owner read/write only. On Windows %TEMP% is already private to the user profile. */
const PRIVATE_FILE_MODE = 0o600;
const DIR_PREFIX = "claude-bridge-mcp-";
/** Hex chars of the data_dir hash in the prefix: enough to tell backends on one machine apart. */
const INSTANCE_HASH_CHARS = 12;
const RM_RETRIES = 3;

export interface McpConfigFile {
  readonly path: string;
  /** Removes the private directory. Idempotent, never throws. */
  dispose(): void;
}

export class McpConfigFiles {
  private readonly prefix: string;

  /**
   * @param instanceKey identifies this backend (its data_dir): stale cleanup only touches this backend's files.
   * @param root parent of the per-process directories; the OS temp dir by default.
   */
  constructor(
    instanceKey: string,
    private readonly root: string = tmpdir(),
  ) {
    const normalized = process.platform === "win32" ? resolve(instanceKey).toLowerCase() : resolve(instanceKey);
    const hash = createHash("sha256").update(normalized, "utf8").digest("hex").slice(0, INSTANCE_HASH_CHARS);
    this.prefix = `${DIR_PREFIX}${hash}-`;
  }

  /**
   * Writes `{"mcpServers": ...}` into a fresh directory (mkdtemp: random name, mode 0700 on POSIX) with an exclusive
   * create. The content holds secrets: never log it.
   */
  write(servers: Record<string, McpServerConfig>): McpConfigFile {
    const dir = mkdtempSync(join(this.root, this.prefix));
    const path = join(dir, FILE_NAME);
    try {
      writeFileSync(path, JSON.stringify({ mcpServers: servers }), { encoding: "utf8", mode: PRIVATE_FILE_MODE, flag: "wx" });
    } catch (err) {
      removeDir(dir);
      throw err;
    }
    let disposed = false;
    return {
      path,
      dispose() {
        if (disposed) return;
        disposed = true;
        removeDir(dir);
      },
    };
  }

  /** Deletes files left by a previous run of this backend (crash, kill). Returns how many directories were removed. */
  removeStale(): number {
    let entries: string[];
    try {
      entries = readdirSync(this.root);
    } catch {
      return 0;
    }
    let removed = 0;
    for (const name of entries) {
      if (!name.startsWith(this.prefix)) continue;
      if (removeDir(join(this.root, name))) removed += 1;
    }
    return removed;
  }
}

function removeDir(dir: string): boolean {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: RM_RETRIES });
    return true;
  } catch {
    return false;
  }
}
