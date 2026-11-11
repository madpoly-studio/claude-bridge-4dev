// Interpreting `claude -p --output-format stream-json --verbose` stdout lines.
import type { TaskUsage } from "@claude-bridge/protocol";

/** Stdout line that is not a JSON object, forwarded as-is so nothing is lost. */
export interface RawLineEvent {
  type: "raw";
  text: string;
}

/** The line as a JSON object, or null when it is anything else (forward it as a RawLineEvent). */
export function parseJsonObjectLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) {
    return null;
  }
  try {
    const value: unknown = JSON.parse(trimmed);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** `session_id` of the `{"type":"system","subtype":"init"}` line; SessionStart hook lines precede it and are ignored. */
export function initSessionId(event: Record<string, unknown>): string | null | undefined {
  if (event.type !== "system" || event.subtype !== "init") {
    return undefined;
  }
  return typeof event.session_id === "string" ? event.session_id : null;
}

export function isResultEvent(event: Record<string, unknown>): boolean {
  return event.type === "result";
}

/** `usage` + `total_cost_usd` of the final result line; null when neither is present. */
export function usageFromResult(result: Record<string, unknown> | null): TaskUsage | null {
  if (!result) {
    return null;
  }
  const usage = result.usage !== null && typeof result.usage === "object" ? (result.usage as TaskUsage) : null;
  const cost = typeof result.total_cost_usd === "number" ? result.total_cost_usd : undefined;
  if (!usage && cost === undefined) {
    return null;
  }
  return { ...(usage ?? {}), ...(cost !== undefined ? { total_cost_usd: cost } : {}) };
}

/** Bus MCP server status reported in the init line, e.g. "connected" / "failed"; undefined when absent. */
export function busMcpStatus(event: Record<string, unknown>, serverName: string): string | undefined {
  const servers = event.mcp_servers;
  if (!Array.isArray(servers)) {
    return undefined;
  }
  const entry = servers.find((s) => s !== null && typeof s === "object" && (s as { name?: unknown }).name === serverName) as
    | { status?: unknown }
    | undefined;
  return typeof entry?.status === "string" ? entry.status : undefined;
}
