import { BUS_MCP_SERVER_NAME } from "@claude-bridge/protocol";

export const DEFAULT_WS_URL: string = import.meta.env.VITE_BRIDGE_WS_URL || "ws://127.0.0.1:8787/ws";

export const STORAGE_KEYS = {
  wsUrl: "claude-bridge.ws-url",
  token: "claude-bridge.token",
  plannerSession: "claude-bridge.planner-session",
  logTab: "claude-bridge.log-tab",
} as const;

export const REQUEST_TIMEOUT_MS = 15_000;
export const RECONNECT_BACKOFF = { initialMs: 1_000, maxMs: 30_000, factor: 2 } as const;

/** Số bus event giữ trong bộ nhớ cho tab Events. */
export const MAX_BUS_EVENTS = 2_000;
/** Số session event giữ cho mỗi luồng. */
export const MAX_STREAM_RECORDS = 5_000;

export const DEMO_QUERY_PARAM = "demo";

export const BUS_TOOL_PREFIX = `mcp__${BUS_MCP_SERVER_NAME}__`;

/** Chu kỳ cập nhật đồng hồ cho thời lượng hiển thị. */
export const CLOCK_TICK_MS = 30_000;
export const COUNTDOWN_TICK_MS = 1_000;

export const NOTICE_TIMEOUT_MS = 8_000;
