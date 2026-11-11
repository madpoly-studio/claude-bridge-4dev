// Trừu tượng hóa cách chạy một session Claude (mục 5.2): bản thật dùng Agent SDK `query()` với prompt streaming,
// bản giả (FakeClaudeDriver) cho test. Session Manager chỉ phụ thuộc interface này.
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";

/**
 * Tập con của `Options` (Agent SDK 0.3.322) mà bridge dùng; profile của planner / orchestrator dựng ra object này.
 * Driver thật thêm env (xác thực), executable, stderr; driver giả mô phỏng hooks + canUseTool.
 */
export type ClaudeSessionOptions = Pick<
  Options,
  | "resume"
  | "model"
  | "systemPrompt"
  | "mcpServers"
  | "strictMcpConfig"
  | "tools"
  | "allowedTools"
  | "disallowedTools"
  | "permissionMode"
  | "settingSources"
  | "hooks"
  | "canUseTool"
> & {
  /** Luôn tuyệt đối, lấy từ cấu hình (REPO_WHITELIST / orchestrators.*.cwd), không bao giờ từ UI. */
  cwd: string;
};

export interface ClaudeSessionHandle {
  /** Luồng message của session; kết thúc khi process thoát, throw khi process chết bất thường. */
  readonly messages: AsyncIterable<SDKMessage>;
  /** Đưa một user turn vào prompt streaming. Không có tác dụng sau `close()`. */
  send(text: string): void;
  /** Ngắt turn đang chạy (Query.interrupt). Session vẫn sống để nhận turn tiếp. */
  interrupt(): Promise<void>;
  /** Đóng prompt và kết thúc process. */
  close(): void;
}

export interface ClaudeDriver {
  /** Không chặn: process được spawn nền, lỗi spawn đi ra qua `messages`. */
  start(options: ClaudeSessionOptions): ClaudeSessionHandle;
}
