// runner.config.json: schema, loading and path resolution.
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEFAULTS } from "@claude-bridge/protocol";
import { z } from "zod";

/** Choices accepted by `claude --permission-mode` (verified on CLI 2.1.322). */
export const PERMISSION_MODES = ["acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan"] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

export const DEFAULT_CONFIG_FILE = "runner.config.json";
export const DEFAULT_BOOTSTRAP_TOKEN_FILE = path.join("data", "runner-bootstrap.token");
export const BOOTSTRAP_TOKEN_ENV = "RUNNER_BOOTSTRAP_TOKEN";

const slotSchema = z.object({
  worker_id: z.string().min(1),
  repo: z.string().min(1),
  worktree_path: z.string().min(1),
  allowed_tools: z.array(z.string().min(1)),
  disallowed_tools: z.array(z.string().min(1)).default([]),
  extra_args: z.array(z.string()).default([]),
  /**
   * Extra MCP config files (e.g. the repo's Jira/GitLab servers). Needed because the worker runs with
   * --strict-mcp-config, which ignores every MCP server not passed through --mcp-config.
   */
  mcp_config_files: z.array(z.string().min(1)).default([]),
  env: z.record(z.string(), z.string()).default({}),
  permission_mode: z.enum(PERMISSION_MODES).default("dontAsk"),
});

const configSchema = z
  .object({
    bus_url: z.url().default(`http://127.0.0.1:${DEFAULTS.PORT}`),
    bootstrap_token_file: z.string().min(1).default(DEFAULT_BOOTSTRAP_TOKEN_FILE),
    host: z.string().min(1).optional(),
    heartbeat_seconds: z.number().int().positive().default(DEFAULTS.HEARTBEAT_SECONDS),
    claude_command: z.array(z.string().min(1)).min(1).default(["claude"]),
    slots: z.array(slotSchema).min(1),
  })
  .superRefine((cfg, ctx) => {
    const seen = new Set<string>();
    cfg.slots.forEach((slot, i) => {
      if (seen.has(slot.worker_id)) {
        ctx.addIssue({ code: "custom", path: ["slots", i, "worker_id"], message: `duplicate worker_id "${slot.worker_id}"` });
      }
      seen.add(slot.worker_id);
    });
  });

export type SlotConfig = z.output<typeof slotSchema>;

export interface RunnerConfig {
  bus_url: string;
  /** Absolute path. */
  bootstrap_token_file: string;
  host: string;
  heartbeat_seconds: number;
  claude_command: string[];
  /** worktree_path and mcp_config_files values are absolute. */
  slots: SlotConfig[];
}

export class ConfigError extends Error {}

/**
 * Validates raw JSON. Relative `worktree_path` / `bootstrap_token_file` resolve against `baseDir`
 * (the directory of the config file). `claude_command` is used verbatim: the child runs with the
 * worktree as cwd, so script paths in it must be absolute.
 */
export function parseConfig(raw: unknown, baseDir: string): RunnerConfig {
  const result = configSchema.safeParse(raw);
  if (!result.success) {
    throw new ConfigError(`invalid runner config:\n${z.prettifyError(result.error)}`);
  }
  const cfg = result.data;
  return {
    bus_url: cfg.bus_url.replace(/\/+$/, ""),
    bootstrap_token_file: path.resolve(baseDir, cfg.bootstrap_token_file),
    host: cfg.host ?? os.hostname(),
    heartbeat_seconds: cfg.heartbeat_seconds,
    claude_command: cfg.claude_command,
    slots: cfg.slots.map((slot) => ({
      ...slot,
      worktree_path: path.resolve(baseDir, slot.worktree_path),
      mcp_config_files: slot.mcp_config_files.map((file) => path.resolve(baseDir, file)),
    })),
  };
}

export async function loadConfig(configPath: string): Promise<RunnerConfig> {
  const absolute = path.resolve(configPath);
  let text: string;
  try {
    text = await readFile(absolute, "utf8");
  } catch (err) {
    throw new ConfigError(`cannot read runner config at ${absolute}: ${(err as Error).message}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new ConfigError(`runner config at ${absolute} is not valid JSON: ${(err as Error).message}`);
  }
  return parseConfig(raw, path.dirname(absolute));
}

/**
 * Bootstrap token for POST /runners/register: env RUNNER_BOOTSTRAP_TOKEN, else the token file.
 * Read on every registration so a token rotated by a backend restart is picked up.
 */
export async function readBootstrapToken(tokenFile: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const fromEnv = env[BOOTSTRAP_TOKEN_ENV]?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  let text: string;
  try {
    text = await readFile(tokenFile, "utf8");
  } catch (err) {
    throw new ConfigError(
      `no bootstrap token: ${BOOTSTRAP_TOKEN_ENV} is unset and ${tokenFile} is unreadable (${(err as Error).message})`,
    );
  }
  const token = text.trim();
  if (!token) {
    throw new ConfigError(`bootstrap token file ${tokenFile} is empty`);
  }
  return token;
}
