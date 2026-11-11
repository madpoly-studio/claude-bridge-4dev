// Driver thật: Agent SDK `query({prompt: AsyncIterable<SDKUserMessage>, options})` (đã đối chiếu sdk.d.ts 0.3.322).
import { type Query, type SDKMessage, type SDKUserMessage, query } from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeAuthMode } from "@claude-bridge/protocol";
import { AsyncQueue } from "../util/asyncQueue.js";
import { buildClaudeEnv } from "./auth.js";
import type { ClaudeDriver, ClaudeSessionHandle, ClaudeSessionOptions } from "./driver.js";

/** Số dòng stderr cuối giữ lại để ghi kèm khi process chết. */
const STDERR_TAIL_LINES = 20;

export interface SdkDriverOptions {
  authMode: ClaudeAuthMode;
  /** null = binary đi kèm SDK. */
  executable: string | null;
  clientApp: string;
  log: { warn(obj: object, msg?: string): void; debug(obj: object, msg?: string): void };
  baseEnv?: NodeJS.ProcessEnv;
}

export class SdkClaudeDriver implements ClaudeDriver {
  private readonly env: Record<string, string | undefined>;

  /** Throw ConfigError ngay khi tạo nếu auth mode `api_key` thiếu ANTHROPIC_API_KEY (fail lúc khởi động). */
  constructor(private readonly opts: SdkDriverOptions) {
    this.env = buildClaudeEnv(opts.authMode, opts.baseEnv ?? process.env, opts.clientApp);
  }

  start(options: ClaudeSessionOptions): ClaudeSessionHandle {
    const prompt = new AsyncQueue<SDKUserMessage>();
    const stderrTail: string[] = [];
    const q: Query = query({
      prompt,
      options: {
        ...options,
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
    return {
      messages: withStderrOnFailure(q, stderrTail),
      send(text: string) {
        prompt.push({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null });
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
async function* withStderrOnFailure(source: Query, stderrTail: readonly string[]): AsyncGenerator<SDKMessage, void> {
  try {
    for await (const message of source) yield message;
  } catch (err) {
    const base = err instanceof Error ? err.message : String(err);
    const tail = stderrTail.length > 0 ? `\n${stderrTail.join("\n")}` : "";
    throw new Error(`${base}${tail}`, { cause: err });
  }
}
