// Driver thật: Agent SDK `query({prompt: AsyncIterable<SDKUserMessage>, options})` (đã đối chiếu sdk.d.ts 0.3.322).
import { type Options, type Query, type SDKMessage, type SDKUserMessage, query } from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeAuthMode } from "@claude-bridge/protocol";
import { AsyncQueue } from "../util/asyncQueue.js";
import { buildClaudeEnv } from "./auth.js";
import type { ClaudeDriver, ClaudeSessionHandle, ClaudeSessionOptions } from "./driver.js";
import type { McpConfigFile, McpConfigFiles } from "./mcpConfigFile.js";

/** Số dòng stderr cuối giữ lại để ghi kèm khi process chết. */
const STDERR_TAIL_LINES = 20;
/** CLI flag (không có `--`) nhận đường dẫn file cấu hình MCP; variadic trên CLI 2.1.322. */
const MCP_CONFIG_FLAG = "mcp-config";

export type QueryFn = (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => Query;

export interface SdkDriverOptions {
  authMode: ClaudeAuthMode;
  /** null = binary đi kèm SDK. */
  executable: string | null;
  clientApp: string;
  /** Nơi ghi cấu hình MCP (chứa secret) thay cho `Options.mcpServers`, vốn bị SDK đưa nguyên JSON vào argv. */
  mcpConfigFiles: McpConfigFiles;
  log: { warn(obj: object, msg?: string): void; debug(obj: object, msg?: string): void };
  baseEnv?: NodeJS.ProcessEnv;
  /** Thay `query` của SDK (test kiểm options thật sự đi tới CLI). */
  queryFn?: QueryFn;
}

export class SdkClaudeDriver implements ClaudeDriver {
  private readonly env: Record<string, string | undefined>;
  private readonly queryFn: QueryFn;

  /** Throw ConfigError ngay khi tạo nếu auth mode `api_key` thiếu ANTHROPIC_API_KEY (fail lúc khởi động). */
  constructor(private readonly opts: SdkDriverOptions) {
    this.env = buildClaudeEnv(opts.authMode, opts.baseEnv ?? process.env, opts.clientApp);
    this.queryFn = opts.queryFn ?? query;
  }

  start(options: ClaudeSessionOptions): ClaudeSessionHandle {
    const prompt = new AsyncQueue<SDKUserMessage>();
    const stderrTail: string[] = [];
    const { mcpServers, ...rest } = options;
    // File sống cùng process: xóa khi luồng message kết thúc (process thoát / close / lỗi).
    const mcpFile: McpConfigFile | null =
      mcpServers && Object.keys(mcpServers).length > 0 ? this.opts.mcpConfigFiles.write(mcpServers) : null;
    let q: Query;
    try {
      q = this.queryFn({
        prompt,
        options: {
          ...rest,
          ...(mcpFile ? { extraArgs: { [MCP_CONFIG_FLAG]: mcpFile.path } } : {}),
          env: this.env,
          ...(this.opts.executable ? { pathToClaudeCodeExecutable: this.opts.executable } : {}),
          stderr: (data: string) => {
            for (const line of data.split(/\r?\n/)) {
              if (line.trim() === "") continue;
              stderrTail.push(line);
              if (stderrTail.length > STDERR_TAIL_LINES) stderrTail.shift();
            }
            this.opts.log.debug({ cwd: options.cwd, stderr: data.trimEnd() }, "claude stderr");
          },
        },
      });
    } catch (err) {
      mcpFile?.dispose();
      throw err;
    }
    const finished = (): void => {
      // Process đã thoát: turn gửi sau đó không có nơi nhận, `send` phải báo thất bại.
      prompt.end();
      mcpFile?.dispose();
    };
    return {
      messages: withStderrOnFailure(q, stderrTail, finished),
      send(text: string): boolean {
        return prompt.push({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null });
      },
      async interrupt() {
        await q.interrupt();
      },
      close() {
        prompt.end();
        q.close();
      },
    };
  }
}

/** Gắn phần cuối stderr vào lỗi để biết vì sao CLI chết (không chứa token: env không bao giờ được in). */
async function* withStderrOnFailure(
  source: Query,
  stderrTail: readonly string[],
  onFinished: () => void,
): AsyncGenerator<SDKMessage, void> {
  try {
    for await (const message of source) yield message;
  } catch (err) {
    const base = err instanceof Error ? err.message : String(err);
    const tail = stderrTail.length > 0 ? `\n${stderrTail.join("\n")}` : "";
    throw new Error(`${base}${tail}`, { cause: err });
  } finally {
    onFinished();
  }
}
