// Options Agent SDK cho từng role (mục 5.2): cwd chỉ từ cấu hình, allowlist tool, MCP server, system prompt.
import type { CanUseTool, McpServerConfig, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { BUS_MCP_SERVER_NAME, ORCHESTRATOR_TOOLS, type WakeMode, busToolFullName } from "@claude-bridge/protocol";
import type { ClaudeSessionOptions } from "../claude/driver.js";
import { RepoPathGuard, SECRET_READ_DENY_RULES } from "../claude/repoPathGuard.js";
import { ToolPolicy, policyDenyMessage, policyHook } from "../claude/toolPolicy.js";
import type { BridgeConfig, McpServerConfigInput, OrchestratorConfig } from "../config.js";
import type { PermissionBroker } from "../permissions/permissionBroker.js";
import { WsError } from "../ws/hub.js";
import type { SessionRow } from "./sessionStore.js";

/** Tool đọc codebase của planner (mục 5.2). */
export const PLANNER_READ_TOOLS = ["Read", "Grep", "Glob"] as const;
/** MCP tool có thể bị hoãn sau tool search; thiếu ToolSearch thì model không nạp được tool Jira / bus. */
export const TOOL_SEARCH = "ToolSearch";

export const PLANNER_PROMPT_APPEND = [
  "Bạn đang chạy trong claude-bridge với vai trò planner.",
  "Bạn chỉ có quyền đọc codebase và đọc Jira. Tool tạo issue Jira luôn chờ người dùng duyệt trên UI.",
  "Nếu yêu cầu tạo issue bị từ chối, đọc lý do, hỏi lại người dùng và chỉnh bản nháp; không thử lại khi chưa thống nhất.",
].join("\n");

const ORCHESTRATOR_ROLE = [
  "Bạn là orchestrator của claude-bridge cho Jira project {PROJECT}. Bạn không viết code, chỉ điều phối.",
  `Chỉ giao việc bằng tool ${busToolFullName("assign_task")}; không có cách giao việc nào khác.`,
];
const BUS_PICTURE = `Jira cùng ${busToolFullName("list_workers")} và ${busToolFullName("list_tasks")}`;

/** wake_mode `auto`: bridge đánh thức theo mọi trigger, orchestrator tự quyết định giao việc. */
export const ORCHESTRATOR_PROMPT_AUTO = [
  ...ORCHESTRATOR_ROLE,
  `Mỗi lần khởi động, sau khi context bị compact, hoặc khi không chắc, dựng lại toàn cảnh từ ${BUS_PICTURE}; ` +
    "không dựa vào trí nhớ hội thoại.",
  "Turn bắt đầu bằng [bridge-event] là turn hệ thống của bridge: chỉ chứa định danh (type, ticket_key, task_id, " +
    "worker_id, category). Tự đọc Jira và bus để lấy nội dung, rồi quyết định có giao việc hay không.",
].join("\n");

/** wake_mode `manual`: chỉ làm khi người dùng yêu cầu; bridge chỉ báo kết quả task. */
export const ORCHESTRATOR_PROMPT_MANUAL = [
  ...ORCHESTRATOR_ROLE,
  "Chế độ thủ công: chỉ giao việc khi người dùng yêu cầu trong turn của họ; không bao giờ tự chọn hay tự giao ticket.",
  `Không đọc Jira khi vừa khởi động. Trước khi thực hiện một yêu cầu (hoặc sau khi context bị compact, khi không chắc), ` +
    `dựng lại toàn cảnh từ ${BUS_PICTURE}; không dựa vào trí nhớ hội thoại.`,
  "Turn bắt đầu bằng [bridge-event] là turn hệ thống của bridge, chỉ báo kết quả task (task.completed / task.failed, " +
    "chỉ có định danh). Đọc kết quả qua bus / Jira và báo ngắn gọn cho người dùng; chỉ giao việc tiếp theo nếu đó là một phần " +
    "yêu cầu rõ ràng của người dùng (ví dụ \"làm lần lượt {PROJECT}-1, {PROJECT}-2\"). Không giao lại task lỗi khi chưa hỏi người dùng.",
].join("\n");

export function orchestratorPromptAppend(mode: WakeMode, projectKey: string): string {
  return (mode === "auto" ? ORCHESTRATOR_PROMPT_AUTO : ORCHESTRATOR_PROMPT_MANUAL).replaceAll("{PROJECT}", projectKey);
}

export interface ProfileDeps {
  config: BridgeConfig;
  broker: PermissionBroker;
  mcpUrl: () => string;
  /** Bearer token của bus cho orchestrator của một project. */
  orchestratorToken: (projectKey: string) => string;
}

export class SessionProfiles {
  private readonly createToolRe: RegExp;

  constructor(private readonly deps: ProfileDeps) {
    this.createToolRe = new RegExp(deps.config.jira_create_tool_pattern);
  }

  isCreateTool(toolName: string): boolean {
    return this.createToolRe.test(toolName);
  }

  optionsFor(row: SessionRow): ClaudeSessionOptions {
    if (row.role === "planner") {
      const repo = this.deps.config.repos.find((r) => r.name === row.repo);
      // cwd chỉ lấy từ whitelist; repo bị gỡ khỏi cấu hình thì session không chạy lại được.
      if (!repo) throw new WsError("FORBIDDEN", `repo ${row.repo ?? "(none)"} is not in the repo whitelist`);
      return this.planner(row.session_id, repo.path);
    }
    const orch = row.project_key ? this.deps.config.orchestrators[row.project_key] : undefined;
    if (!orch || !row.project_key) {
      throw new WsError("FORBIDDEN", `no orchestrator is configured for project ${row.project_key ?? "(none)"}`);
    }
    return this.orchestrator(row.project_key, orch);
  }

  planner(sessionId: string, cwd: string): ClaudeSessionOptions {
    const cfg = this.deps.config.planner;
    const policy = new ToolPolicy([...PLANNER_READ_TOOLS, TOOL_SEARCH, ...cfg.allowed_tools]);
    const gated = (name: string): boolean => this.isCreateTool(name);
    // Lớp quyết định đường dẫn: hook chạy cho MỌI tool call (kể cả đọc trong cwd mà CLI tự cho phép).
    const paths = new RepoPathGuard(cwd);
    const readTools: ReadonlySet<string> = new Set<string>(PLANNER_READ_TOOLS);
    const canUseTool: CanUseTool = async (toolName, input, opts): Promise<PermissionResult> => {
      if (gated(toolName)) {
        return this.deps.broker.requestApproval({
          session_id: sessionId,
          tool: toolName,
          input,
          tool_use_id: opts.toolUseID,
          signal: opts.signal,
        });
      }
      if (!policy.allows(toolName)) return { behavior: "deny", message: policyDenyMessage(toolName) };
      // CLI 2.1.322 cũng hỏi cả đọc TRONG repo (thấy thật khi cwd có tên 8.3 như `CPU124~1`) và có thể không đặt
      // blockedPath: quyết định bằng cùng RepoPathGuard với hook, không dựa vào việc CLI có hỏi hay không.
      if (readTools.has(toolName)) {
        const rejected =
          paths.check(toolName, input) ??
          (opts.blockedPath !== undefined ? paths.check(toolName, { file_path: opts.blockedPath }) : null);
        if (rejected !== null) return { behavior: "deny", message: rejected };
        return { behavior: "allow", updatedInput: input };
      }
      return { behavior: "allow", updatedInput: input };
    };
    return {
      cwd,
      ...this.common(cfg),
      mcpServers: toSdkServers(cfg.mcp_servers),
      tools: policy.builtinTools(),
      allowedTools: policy.preapprovedMcpTools(gated),
      disallowedTools: [...SECRET_READ_DENY_RULES],
      hooks: { PreToolUse: [policyHook({ policy, gated, inspect: (name, input) => paths.check(name, input) })] },
      canUseTool,
      systemPrompt: promptAppend(PLANNER_PROMPT_APPEND, cfg.system_prompt_append),
    };
  }

  orchestrator(projectKey: string, cfg: OrchestratorConfig): ClaudeSessionOptions {
    const busTools = ORCHESTRATOR_TOOLS.map((t) => busToolFullName(t));
    const policy = new ToolPolicy([TOOL_SEARCH, ...busTools, ...cfg.allowed_tools]);
    // Jira chỉ đọc: tool tạo issue bị chặn cho orchestrator kể cả khi lỡ nằm trong allowed_tools.
    const forbidden = (name: string): boolean => this.isCreateTool(name);
    const canUseTool: CanUseTool = async (toolName, input): Promise<PermissionResult> =>
      policy.allows(toolName) && !forbidden(toolName)
        ? { behavior: "allow", updatedInput: input }
        : { behavior: "deny", message: policyDenyMessage(toolName) };
    return {
      cwd: cfg.cwd,
      ...this.common(cfg),
      mcpServers: {
        ...toSdkServers(cfg.mcp_servers),
        [BUS_MCP_SERVER_NAME]: {
          type: "http",
          url: this.deps.mcpUrl(),
          // Token chỉ có quyền trên ticket của project này (mục 7.6). SdkClaudeDriver ghi nó vào file tạm, không vào argv.
          headers: { Authorization: `Bearer ${this.deps.orchestratorToken(projectKey)}` },
          alwaysLoad: true,
        },
      },
      tools: policy.builtinTools(),
      allowedTools: policy.preapprovedMcpTools(forbidden),
      hooks: { PreToolUse: [policyHook({ policy, forbidden })] },
      canUseTool,
      systemPrompt: promptAppend(orchestratorPromptAppend(this.deps.config.wake_mode, projectKey), cfg.system_prompt_append),
    };
  }

  private common(
    cfg: { model: string | null; setting_sources: ("user" | "project" | "local")[] },
  ): Pick<ClaudeSessionOptions, "model" | "permissionMode" | "settingSources" | "strictMcpConfig"> {
    return {
      ...(cfg.model ? { model: cfg.model } : {}),
      // Bỏ trống thì CLI có thể chọn `auto` (classifier tự duyệt): luôn đặt `default` để mọi quyết định qua bridge.
      permissionMode: "default",
      settingSources: cfg.setting_sources,
      // Chỉ MCP server do bridge cấu hình; bỏ qua .mcp.json của repo và server trong settings của user.
      strictMcpConfig: true,
    };
  }
}

function promptAppend(base: string, extra: string | null): ClaudeSessionOptions["systemPrompt"] {
  return { type: "preset", preset: "claude_code", append: extra ? `${base}\n\n${extra}` : base };
}

function toSdkServers(servers: Record<string, McpServerConfigInput>): Record<string, McpServerConfig> {
  return { ...servers } as Record<string, McpServerConfig>;
}
