// Builds the headless `claude -p` argument list and the per-task MCP config file.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BUS_MCP_SERVER_NAME, WORKER_TOOLS, busToolFullName } from "@claude-bridge/protocol";
import type { SlotConfig } from "./config.js";
import { liveResources } from "./liveResources.js";

const MCP_CONFIG_FILE_NAME = "mcp-config.json";
/** Owner read/write only. Ignored on Windows, where %TEMP% is already private to the user profile. */
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIR_PREFIX = "claude-bridge-task-";

export interface McpConfigFile {
  path: string;
  /** Removes the temp directory. Never throws; if removal fails, the runner retries at exit. */
  dispose(): Promise<void>;
}

/**
 * Writes `{"mcpServers":{"bridge-bus":{type:"http",url,headers:{Authorization}}}}` to a fresh private
 * temp dir. A file path avoids Windows argv quoting of inline JSON and keeps the task token off the
 * command line (visible to other processes). The content holds the token: never log it.
 */
export async function writeMcpConfigFile(mcpUrl: string, taskToken: string): Promise<McpConfigFile> {
  const dir = await mkdtemp(path.join(os.tmpdir(), PRIVATE_DIR_PREFIX));
  liveResources.addTempDir(dir);
  const filePath = path.join(dir, MCP_CONFIG_FILE_NAME);
  const content = {
    mcpServers: {
      [BUS_MCP_SERVER_NAME]: {
        type: "http",
        url: mcpUrl,
        headers: { Authorization: `Bearer ${taskToken}` },
      },
    },
  };
  try {
    await writeFile(filePath, JSON.stringify(content), { encoding: "utf8", mode: PRIVATE_FILE_MODE, flag: "wx" });
  } catch (err) {
    await removeDir(dir);
    throw err;
  }
  return {
    path: filePath,
    dispose: () => removeDir(dir),
  };
}

async function removeDir(dir: string): Promise<void> {
  try {
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
    liveResources.removeTempDir(dir);
  } catch {
    // Stays registered: LiveResources.cleanupSync deletes it before the runner exits.
  }
}

/** allowed_tools from the slot plus the three worker bus tools, deduplicated, order kept. */
export function effectiveAllowedTools(slot: SlotConfig): string[] {
  const tools = [...slot.allowed_tools, ...WORKER_TOOLS.map((t) => busToolFullName(t))];
  return [...new Set(tools)];
}

/**
 * Flags verified against `claude --help` on CLI 2.1.322. The prompt is written to stdin (no positional
 * prompt). `--mcp-config`, `--allowedTools` and `--disallowedTools` are variadic: each value is its own
 * argv element and the list ends at the next `--flag`.
 */
export function buildClaudeArgs(slot: SlotConfig, mcpConfigPath: string): string[] {
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--mcp-config",
    mcpConfigPath,
    ...slot.mcp_config_files,
    "--strict-mcp-config",
    "--permission-mode",
    slot.permission_mode,
    "--allowedTools",
    ...effectiveAllowedTools(slot),
  ];
  if (slot.disallowed_tools.length > 0) {
    args.push("--disallowedTools", ...slot.disallowed_tools);
  }
  args.push(...slot.extra_args);
  return args;
}
