// Driver giả cho test (không spawn process). Kịch bản theo turn: text, tool_use đi qua PreToolUse hook + canUseTool
// giống thứ tự của CLI, tool_result, result; mô phỏng interrupt và process chết.
import { randomUUID } from "node:crypto";
import type { HookCallbackMatcher, PermissionResult, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { AsyncQueue } from "../util/asyncQueue.js";
import type { ClaudeDriver, ClaudeSessionHandle, ClaudeSessionOptions } from "./driver.js";

/** Built-in chỉ đọc mà CLI tự cho phép trong cwd ở permissionMode `default`. */
const AUTO_ALLOWED_READ_TOOLS = new Set(["Read", "Grep", "Glob"]);

export class FakeInterrupted extends Error {
  constructor() {
    super("turn interrupted");
    this.name = "FakeInterrupted";
  }
}

export interface FakeToolOutcome {
  allowed: boolean;
  tool_use_id: string;
  /** Input thật sự chạy (đã áp updatedInput nếu được sửa). */
  input: Record<string, unknown>;
  /** Lý do từ chối (khi allowed = false). */
  message: string | null;
  /** Lớp đã quyết định. */
  decided_by: "hook" | "unknown_tool" | "preapproved" | "auto" | "canUseTool";
}

export interface FakeUseToolOptions {
  /** Mô phỏng truy cập đường dẫn ngoài cwd: CLI hỏi canUseTool kèm blockedPath. */
  blockedPath?: string;
  /** Kết quả tool được trả như lỗi (is_error). */
  isError?: boolean;
}

export type FakeTurnScript = (turn: FakeTurn) => Promise<void> | void;

export class FakeTurn {
  constructor(
    readonly session: FakeClaudeSession,
    readonly text: string,
    readonly signal: AbortSignal,
  ) {}

  say(text: string): void {
    this.throwIfInterrupted();
    this.session.emit(assistant(this.session.claudeSessionId, [{ type: "text", text }]));
  }

  /** tool_use → PreToolUse hooks → (allowedTools | auto | canUseTool) → chạy `run` → tool_result. */
  async useTool(
    name: string,
    input: Record<string, unknown>,
    run?: (effectiveInput: Record<string, unknown>) => unknown,
    opts: FakeUseToolOptions = {},
  ): Promise<FakeToolOutcome> {
    this.throwIfInterrupted();
    const s = this.session;
    const id = `toolu_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
    s.emit(assistant(s.claudeSessionId, [{ type: "tool_use", id, name, input }]));
    const outcome = await s.decide(name, input, id, this.signal, opts.blockedPath);
    this.throwIfInterrupted();
    if (!outcome.allowed) {
      s.emit(toolResult(s.claudeSessionId, id, outcome.message ?? "denied", true));
      return outcome;
    }
    const output = run ? await run(outcome.input) : "ok";
    const text = typeof output === "string" ? output : JSON.stringify(output);
    s.emit(toolResult(s.claudeSessionId, id, text, opts.isError === true));
    return outcome;
  }

  /** Giữ turn cho tới khi bị interrupt (test ngắt turn). */
  waitForInterrupt(): Promise<void> {
    if (this.signal.aborted) return Promise.resolve();
    return new Promise((resolve) => this.signal.addEventListener("abort", () => resolve(), { once: true }));
  }

  private throwIfInterrupted(): void {
    if (this.signal.aborted) throw new FakeInterrupted();
  }
}

export class FakeClaudeSession implements ClaudeSessionHandle {
  readonly claudeSessionId: string;
  readonly sent: string[] = [];
  interrupts = 0;
  closed = false;
  private readonly queue = new AsyncQueue<SDKMessage>();
  private readonly inbox: string[] = [];
  private processing = false;
  private initialized = false;
  private turnAbort: AbortController | null = null;

  constructor(
    private readonly driver: FakeClaudeDriver,
    readonly options: ClaudeSessionOptions,
  ) {
    this.claudeSessionId = options.resume ?? randomUUID();
  }

  get messages(): AsyncIterable<SDKMessage> {
    return this.queue;
  }

  get busy(): boolean {
    return this.processing;
  }

  send(text: string): boolean {
    if (this.closed) return false;
    this.sent.push(text);
    this.inbox.push(text);
    if (!this.processing) void this.processInbox();
    return true;
  }

  async interrupt(): Promise<void> {
    this.interrupts += 1;
    this.turnAbort?.abort();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.turnAbort?.abort();
    this.queue.end();
  }

  /** Process chết bất thường: iterator `messages` throw. */
  crash(error: Error = new Error("Claude Code process exited with code 1")): void {
    if (this.closed) return;
    this.closed = true;
    this.turnAbort?.abort();
    this.queue.fail(error);
  }

  emit(message: Record<string, unknown>): void {
    this.queue.push(message as unknown as SDKMessage);
  }

  emitRateLimit(info: Record<string, unknown>): void {
    this.emit({ type: "rate_limit_event", rate_limit_info: info, uuid: randomUUID(), session_id: this.claudeSessionId });
  }

  /** Thứ tự quyết định của CLI: hook deny/ask → tool có tồn tại → allowedTools → tự cho phép đọc → canUseTool. */
  async decide(
    name: string,
    input: Record<string, unknown>,
    toolUseId: string,
    signal: AbortSignal,
    blockedPath: string | undefined,
  ): Promise<FakeToolOutcome> {
    const base = { tool_use_id: toolUseId, input };
    let mustAsk = false;
    for (const matcher of this.options.hooks?.PreToolUse ?? []) {
      if (!matcherApplies(matcher, name)) continue;
      for (const hook of matcher.hooks) {
        const out = await hook(
          {
            hook_event_name: "PreToolUse",
            tool_name: name,
            tool_input: input,
            tool_use_id: toolUseId,
            session_id: this.claudeSessionId,
            transcript_path: "",
            cwd: this.options.cwd,
          },
          toolUseId,
          { signal },
        );
        const specific = "hookSpecificOutput" in out ? out.hookSpecificOutput : undefined;
        if (specific?.hookEventName !== "PreToolUse") continue;
        if (specific.permissionDecision === "deny") {
          return { ...base, allowed: false, message: specific.permissionDecisionReason ?? "denied by hook", decided_by: "hook" };
        }
        if (specific.permissionDecision === "ask") mustAsk = true;
      }
    }
    const isMcp = name.startsWith("mcp__");
    const builtins = this.options.tools;
    if (!isMcp && Array.isArray(builtins) && !builtins.includes(name)) {
      return { ...base, allowed: false, message: `No such tool available: ${name}`, decided_by: "unknown_tool" };
    }
    if (!mustAsk && this.options.allowedTools?.includes(name)) return { ...base, allowed: true, message: null, decided_by: "preapproved" };
    if (!mustAsk && blockedPath === undefined && AUTO_ALLOWED_READ_TOOLS.has(name)) {
      return { ...base, allowed: true, message: null, decided_by: "auto" };
    }
    if (!this.options.canUseTool) return { ...base, allowed: false, message: "no permission handler", decided_by: "canUseTool" };
    const result: PermissionResult | null = await this.options.canUseTool(name, input, {
      signal,
      toolUseID: toolUseId,
      requestId: `req_${toolUseId}`,
      ...(blockedPath !== undefined ? { blockedPath } : {}),
    });
    if (result === null) return { ...base, allowed: false, message: "no permission decision", decided_by: "canUseTool" };
    if (result.behavior === "allow") {
      return { ...base, input: result.updatedInput ?? input, allowed: true, message: null, decided_by: "canUseTool" };
    }
    return { ...base, allowed: false, message: result.message, decided_by: "canUseTool" };
  }

  private async processInbox(): Promise<void> {
    this.processing = true;
    try {
      while (this.inbox.length > 0 && !this.closed) {
        const text = this.inbox.shift() as string;
        if (!this.initialized) {
          this.initialized = true;
          this.emit(initMessage(this.claudeSessionId, this.options));
        }
        const abort = new AbortController();
        this.turnAbort = abort;
        try {
          await this.driver.script(new FakeTurn(this, text, abort.signal));
        } catch (err) {
          if (!(err instanceof FakeInterrupted) && !abort.signal.aborted) {
            this.crash(err instanceof Error ? err : new Error(String(err)));
            return;
          }
        }
        this.turnAbort = null;
        if (this.closed) return;
        const interrupted = abort.signal.aborted;
        this.emit({
          type: "result",
          subtype: interrupted ? "error_during_execution" : "success",
          is_error: interrupted,
          result: interrupted ? "" : "done",
          num_turns: 1,
          duration_ms: 0,
          duration_api_ms: 0,
          total_cost_usd: 0,
          uuid: randomUUID(),
          session_id: this.claudeSessionId,
        });
      }
    } finally {
      this.processing = false;
    }
  }
}

export class FakeClaudeDriver implements ClaudeDriver {
  readonly sessions: FakeClaudeSession[] = [];
  /** Kịch bản cho mỗi turn; mặc định trả lời `echo: <text>`. */
  script: FakeTurnScript = (turn) => turn.say(`echo: ${turn.text}`);

  start(options: ClaudeSessionOptions): FakeClaudeSession {
    const session = new FakeClaudeSession(this, options);
    this.sessions.push(session);
    return session;
  }

  last(): FakeClaudeSession {
    const s = this.sessions[this.sessions.length - 1];
    if (!s) throw new Error("FakeClaudeDriver: no session started");
    return s;
  }
}

function matcherApplies(matcher: HookCallbackMatcher, toolName: string): boolean {
  return matcher.matcher === undefined || new RegExp(`^(?:${matcher.matcher})$`).test(toolName);
}

function initMessage(sessionId: string, options: ClaudeSessionOptions): Record<string, unknown> {
  return {
    type: "system",
    subtype: "init",
    session_id: sessionId,
    cwd: options.cwd,
    tools: Array.isArray(options.tools) ? options.tools : [],
    mcp_servers: Object.keys(options.mcpServers ?? {}).map((name) => ({ name, status: "connected" })),
    model: options.model ?? "fake-model",
    permissionMode: options.permissionMode ?? "default",
    apiKeySource: "none",
    claude_code_version: "fake",
    slash_commands: [],
    output_style: "default",
    skills: [],
    plugins: [],
    uuid: randomUUID(),
  };
}

function assistant(sessionId: string, content: Record<string, unknown>[]): Record<string, unknown> {
  return {
    type: "assistant",
    message: { id: `msg_${randomUUID()}`, type: "message", role: "assistant", model: "fake-model", content, stop_reason: null },
    parent_tool_use_id: null,
    uuid: randomUUID(),
    session_id: sessionId,
  };
}

function toolResult(sessionId: string, toolUseId: string, text: string, isError: boolean): Record<string, unknown> {
  return {
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: text, is_error: isError }] },
    parent_tool_use_id: null,
    uuid: randomUUID(),
    session_id: sessionId,
  };
}
