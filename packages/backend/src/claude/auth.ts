// Xác thực Claude (mục 4.2): `subscription` dùng đăng nhập sẵn của `claude` CLI, `api_key` dùng ANTHROPIC_API_KEY.
import type { ClaudeAuthMode } from "@claude-bridge/protocol";
import { ConfigError } from "../config.js";

/** Biến môi trường khiến CLI dùng API key / bearer thay cho đăng nhập seat. */
export const API_CREDENTIAL_ENV_VARS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"] as const;

/**
 * Env cho process Claude con. `subscription`: bỏ các biến credential API để CLI dùng đăng nhập của seat.
 * `api_key`: bắt buộc có ANTHROPIC_API_KEY (throw ConfigError lúc khởi động nếu thiếu).
 */
export function buildClaudeEnv(
  mode: ClaudeAuthMode,
  baseEnv: NodeJS.ProcessEnv,
  clientApp: string,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...baseEnv, CLAUDE_AGENT_SDK_CLIENT_APP: clientApp };
  if (mode === "subscription") {
    for (const name of API_CREDENTIAL_ENV_VARS) delete env[name];
    return env;
  }
  const key = baseEnv.ANTHROPIC_API_KEY;
  if (key === undefined || key.trim() === "") {
    throw new ConfigError("claude_auth_mode is api_key but ANTHROPIC_API_KEY is not set");
  }
  return env;
}
