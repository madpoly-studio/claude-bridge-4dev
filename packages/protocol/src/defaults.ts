// Cấu hình mặc định (system design mục 13). Backend/runner đọc override từ biến môi trường.
export const DEFAULTS = {
  MAX_CONCURRENCY: 2,
  TASK_TIMEOUT_MINUTES: 60,
  HEARTBEAT_SECONDS: 15,
  HEARTBEAT_LOST_SECONDS: 45,
  ASSIGN_START_TIMEOUT_SECONDS: 60,
  WAKE_DEBOUNCE_SECONDS: 10,
  ORCH_TICK_MINUTES: 10,
  JIRA_POLL_SECONDS: 60,
  AGENT_LABEL: "agent",
  CLAUDE_AUTH_MODE: "subscription",
  LONG_POLL_WAIT_SECONDS: 30,
  PORT: 8787,
} as const;

export type ClaudeAuthMode = "subscription" | "api_key";
