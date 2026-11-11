// Allowlist tool của session bridge (mục 5.3 dòng cuối, mục 12): ngoài allowlist là từ chối.
// Áp ở ba lớp: `tools` (built-in), PreToolUse hook (mọi tool, kể cả tool đã được allow rule cho phép) và canUseTool.
import type { HookCallbackMatcher, HookJSONOutput } from "@anthropic-ai/claude-agent-sdk";

const MCP_PREFIX = "mcp__";

/** Khớp chính xác, hoặc theo tiền tố khi pattern kết thúc bằng `*`. */
export function matchesToolPattern(pattern: string, toolName: string): boolean {
  return pattern.endsWith("*") ? toolName.startsWith(pattern.slice(0, -1)) : pattern === toolName;
}

export class ToolPolicy {
  private readonly patterns: readonly string[];

  constructor(patterns: Iterable<string>) {
    this.patterns = [...new Set(patterns)];
  }

  allows(toolName: string): boolean {
    return this.patterns.some((p) => matchesToolPattern(p, toolName));
  }

  /** Tên built-in (không phải MCP, không wildcard) cho `Options.tools`. */
  builtinTools(): string[] {
    return this.patterns.filter((p) => !p.startsWith(MCP_PREFIX) && !p.endsWith("*"));
  }

  /** Tên MCP chính xác được phép chạy không hỏi (`Options.allowedTools`). Pattern wildcard đi qua canUseTool. */
  preapprovedMcpTools(exclude: (toolName: string) => boolean): string[] {
    return this.patterns.filter((p) => p.startsWith(MCP_PREFIX) && !p.endsWith("*") && !exclude(p));
  }
}

export interface PolicyHookOptions {
  policy: ToolPolicy;
  /** Tool phải qua gate duyệt: hook trả `ask` để luôn đi tới canUseTool, kể cả khi có allow rule. */
  gated?: (toolName: string) => boolean;
  /** Tool luôn bị từ chối, kể cả khi khớp allowlist. */
  forbidden?: (toolName: string) => boolean;
}

export function policyDenyMessage(toolName: string): string {
  return `Tool ${toolName} is not allowed in this claude-bridge session.`;
}

/**
 * PreToolUse hook: `deny` cho tool ngoài allowlist, `ask` cho tool có gate, còn lại để luồng permission bình thường
 * quyết định (không bao giờ trả `allow`, để canUseTool vẫn được gọi). `onFailure: "block"`: hook lỗi thì tool bị chặn.
 */
export function policyHook(opts: PolicyHookOptions): HookCallbackMatcher {
  return {
    onFailure: "block",
    hooks: [
      async (input): Promise<HookJSONOutput> => {
        if (input.hook_event_name !== "PreToolUse") return {};
        const name = input.tool_name;
        if (opts.forbidden?.(name) === true || (!opts.policy.allows(name) && opts.gated?.(name) !== true)) {
          return {
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "deny",
              permissionDecisionReason: policyDenyMessage(name),
            },
          };
        }
        if (opts.gated?.(name) === true) {
          return {
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "ask",
              permissionDecisionReason: "requires approval in the claude-bridge UI",
            },
          };
        }
        return {};
      },
    ],
  };
}
