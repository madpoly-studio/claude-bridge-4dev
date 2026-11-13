// Cấu hình backend: file `bridge.config.json` + override bằng biến môi trường (system design mục 13).
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { BUS_MCP_SERVER_NAME, DEFAULTS, WAKE_MODES } from "@claude-bridge/protocol";
import { z } from "zod";
import { canonicalPath, isPathInside } from "./util/paths.js";

/** Host luôn là loopback (mục 12). Không cấu hình được. */
export const BIND_HOST = "127.0.0.1";

export const DEFAULT_JIRA_CREATE_TOOL_PATTERN =
  "(^|__)(create_issue|jira_create_issue|createJiraIssue|create_jira_issue)$";

const positiveInt = z.number().int().positive();

/** Tên tool: chính xác, hoặc tiền tố kết thúc bằng một dấu `*` (ví dụ `mcp__jira__jira_get_*`). */
const toolPatternSchema = z
  .string()
  .min(1)
  .refine((p) => !p.slice(0, -1).includes("*"), { message: "only a single trailing * wildcard is supported" });

const settingSourcesSchema = z.array(z.enum(["user", "project", "local"])).default([]);

const mcpCommonFields = {
  timeout: positiveInt.optional(),
  alwaysLoad: z.boolean().optional(),
};

/** Cấu hình MCP server truyền nguyên cho Agent SDK (`Options.mcpServers`). */
const mcpServerSchema = z.union([
  z
    .object({
      type: z.literal("stdio").optional(),
      command: z.string().min(1),
      args: z.array(z.string()).optional(),
      env: z.record(z.string(), z.string()).optional(),
      ...mcpCommonFields,
    })
    .strict(),
  z
    .object({
      type: z.enum(["http", "sse"]),
      url: z.url(),
      headers: z.record(z.string(), z.string()).optional(),
      ...mcpCommonFields,
    })
    .strict(),
]);

const mcpServersSchema = z
  .record(z.string().regex(/^[A-Za-z0-9_-]+$/, "MCP server name: letters, digits, _ and - only"), mcpServerSchema)
  .refine((servers) => !(BUS_MCP_SERVER_NAME in servers), { message: `"${BUS_MCP_SERVER_NAME}" is reserved for the bus` })
  .default({});

const roleFields = {
  mcp_servers: mcpServersSchema,
  allowed_tools: z.array(toolPatternSchema).default([]),
  system_prompt_append: z.string().min(1).nullable().default(null),
  model: z.string().min(1).nullable().default(null),
  /** Nguồn settings của Claude Code được nạp; mặc định không nạp gì để allow rule của user không nới quyền. */
  setting_sources: settingSourcesSchema,
};

/**
 * Planner chạy trong repo do worker ghi: settings `project` / `local` của repo (.claude/settings*.json) có thể cài hook,
 * env (ANTHROPIC_BASE_URL, ...) hay apiKeyHelper, nên không được nạp. Nội dung CLAUDE.md đưa qua system_prompt_append.
 */
const plannerSchema = z
  .object({
    ...roleFields,
    setting_sources: settingSourcesSchema.refine((sources) => sources.every((s) => s === "user"), {
      message: 'planner may only load "user" settings: "project" and "local" come from the repo, which workers write',
    }),
  })
  .strict();

const orchestratorSchema = z
  .object({
    /** Thư mục làm việc riêng của orchestrator (không phải repo code). */
    cwd: z.string().min(1),
    ...roleFields,
  })
  .strict();

const repoSchema = z.object({
  name: z.string().min(1),
  path: z.string().min(1),
  project_key: z.string().min(1).nullable().default(null),
});

const fileSchema = z
  .object({
    port: z.number().int().min(0).max(65535).default(DEFAULTS.PORT),
    data_dir: z.string().min(1).default("./data"),
    allowed_origins: z.array(z.string().min(1)).default([]),
    repos: z.array(repoSchema).default([]),
    projects: z.array(z.string().min(1)).default([]),
    max_concurrency: positiveInt.default(DEFAULTS.MAX_CONCURRENCY),
    task_timeout_minutes: positiveInt.default(DEFAULTS.TASK_TIMEOUT_MINUTES),
    heartbeat_seconds: positiveInt.default(DEFAULTS.HEARTBEAT_SECONDS),
    heartbeat_lost_seconds: positiveInt.default(DEFAULTS.HEARTBEAT_LOST_SECONDS),
    assign_start_timeout_seconds: positiveInt.default(DEFAULTS.ASSIGN_START_TIMEOUT_SECONDS),
    wake_debounce_seconds: positiveInt.default(DEFAULTS.WAKE_DEBOUNCE_SECONDS),
    orch_tick_minutes: positiveInt.default(DEFAULTS.ORCH_TICK_MINUTES),
    /**
     * `manual`: orchestrator chỉ làm khi người dùng yêu cầu; chỉ task.completed / task.failed đánh thức nó.
     * `auto`: thêm worker.registered, ticket.created có label agent, tick mỗi `orch_tick_minutes` và tick sau khi khởi động lại.
     */
    wake_mode: z.enum(WAKE_MODES).default(DEFAULTS.WAKE_MODE),
    jira_poll_seconds: positiveInt.default(DEFAULTS.JIRA_POLL_SECONDS),
    agent_label: z.string().min(1).default(DEFAULTS.AGENT_LABEL),
    claude_auth_mode: z.enum(["subscription", "api_key"]).default(DEFAULTS.CLAUDE_AUTH_MODE),
    jira_create_tool_pattern: z
      .string()
      .min(1)
      .refine(isValidRegex, { message: "must be a valid regular expression" })
      .default(DEFAULT_JIRA_CREATE_TOOL_PATTERN),
    jira_env_file: z.string().min(1).nullable().default(null),
    /** Đường dẫn file thực thi `claude`; null = binary đi kèm Agent SDK. */
    claude_executable: z.string().min(1).nullable().default(null),
    planner: plannerSchema.prefault({}),
    /** Orchestrator theo Jira project key; khóa phải nằm trong `projects`. */
    orchestrators: z.record(z.string().min(1), orchestratorSchema).default({}),
    /** true: khởi động mọi orchestrator đã cấu hình khi backend listen; false: khi project được chọn / có tin nhắn. */
    orchestrator_autostart: z.boolean().default(true),
    pairing_token: z.string().min(16).nullable().default(null),
    runner_bootstrap_token: z.string().min(16).nullable().default(null),
  })
  .strict();

export type RepoConfig = z.infer<typeof repoSchema>;
export type McpServerConfigInput = z.infer<typeof mcpServerSchema>;
export type PlannerConfig = z.infer<typeof plannerSchema>;
export type OrchestratorConfig = z.infer<typeof orchestratorSchema>;
export type BridgeConfig = z.infer<typeof fileSchema> & {
  /** Đường dẫn tuyệt đối đã resolve của data_dir. */
  data_dir: string;
  /** File cấu hình đã đọc, null nếu chạy bằng mặc định. */
  config_path: string | null;
};

export type ConfigInput = z.input<typeof fileSchema>;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function isValidRegex(pattern: string): boolean {
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

/** Map biến môi trường → khóa cấu hình. Giá trị env luôn thắng file. */
function envOverrides(env: NodeJS.ProcessEnv): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const int = (name: string, key: string): void => {
    const raw = env[name];
    if (raw === undefined || raw === "") return;
    const value = Number(raw);
    if (!Number.isInteger(value)) throw new ConfigError(`env ${name} must be an integer, got "${raw}"`);
    out[key] = value;
  };
  const str = (name: string, key: string): void => {
    const raw = env[name];
    if (raw !== undefined && raw !== "") out[key] = raw;
  };
  int("BRIDGE_PORT", "port");
  int("MAX_CONCURRENCY", "max_concurrency");
  int("TASK_TIMEOUT_MINUTES", "task_timeout_minutes");
  int("ORCH_TICK_MINUTES", "orch_tick_minutes");
  int("JIRA_POLL_SECONDS", "jira_poll_seconds");
  str("CLAUDE_AUTH_MODE", "claude_auth_mode");
  str("WAKE_MODE", "wake_mode");
  str("BRIDGE_PAIRING_TOKEN", "pairing_token");
  str("RUNNER_BOOTSTRAP_TOKEN", "runner_bootstrap_token");
  const origins = env.ALLOWED_ORIGINS;
  if (origins !== undefined && origins !== "") {
    out.allowed_origins = origins
      .split(",")
      .map((o) => o.trim())
      .filter((o) => o.length > 0);
  }
  return out;
}

/**
 * Validate + chuẩn hóa một object cấu hình thô (dùng chung cho file và test).
 * `baseDir` dùng để resolve `data_dir`, `jira_env_file` và `orchestrators.*.cwd` tương đối.
 */
export function parseConfig(raw: unknown, baseDir: string, configPath: string | null = null): BridgeConfig {
  const result = fileSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new ConfigError(`invalid bridge config${configPath ? ` (${configPath})` : ""}: ${issues}`);
  }
  const cfg = result.data;
  for (const key of Object.keys(cfg.orchestrators)) {
    if (!cfg.projects.includes(key)) {
      throw new ConfigError(
        `invalid bridge config${configPath ? ` (${configPath})` : ""}: orchestrators.${key}: ${key} is not listed in projects`,
      );
    }
  }
  const abs = (p: string): string => (isAbsolute(p) ? p : resolve(baseDir, p));
  const jiraEnvFile = cfg.jira_env_file === null ? null : abs(cfg.jira_env_file);
  if (jiraEnvFile !== null) {
    // Planner đọc được mọi file trong repo: file chứa Jira PAT phải nằm ngoài mọi repo trong whitelist.
    const envPath = canonicalPath(jiraEnvFile);
    const repo = cfg.repos.find((r) => isPathInside(canonicalPath(abs(r.path)), envPath));
    if (repo) {
      throw new ConfigError(
        `invalid bridge config${configPath ? ` (${configPath})` : ""}: jira_env_file must not be inside repo "${repo.name}" (${repo.path})`,
      );
    }
  }
  const orchestrators: Record<string, OrchestratorConfig> = {};
  for (const [key, orch] of Object.entries(cfg.orchestrators)) orchestrators[key] = { ...orch, cwd: abs(orch.cwd) };
  return {
    ...cfg,
    data_dir: abs(cfg.data_dir),
    jira_env_file: jiraEnvFile,
    orchestrators,
    config_path: configPath,
  };
}

/**
 * Đọc cấu hình: file ở `BRIDGE_CONFIG` (mặc định `./bridge.config.json` theo cwd), rồi áp env.
 * Đường dẫn tương đối trong file được resolve theo thư mục chứa file.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): BridgeConfig {
  const explicit = env.BRIDGE_CONFIG;
  const configPath = resolve(cwd, explicit && explicit !== "" ? explicit : "./bridge.config.json");
  let fileValues: Record<string, unknown> = {};
  let usedPath: string | null = null;
  if (existsSync(configPath)) {
    try {
      fileValues = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    } catch (err) {
      throw new ConfigError(`cannot parse ${configPath}: ${(err as Error).message}`);
    }
    if (typeof fileValues !== "object" || fileValues === null || Array.isArray(fileValues)) {
      throw new ConfigError(`${configPath} must contain a JSON object`);
    }
    usedPath = configPath;
  } else if (explicit) {
    throw new ConfigError(`BRIDGE_CONFIG points to a missing file: ${configPath}`);
  }
  const baseDir = usedPath ? dirname(usedPath) : cwd;
  return parseConfig({ ...fileValues, ...envOverrides(env) }, baseDir, usedPath);
}
