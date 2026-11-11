// Diễn giải SessionEventRecord (message SDK / stream-json thô) thành item hiển thị.
// Phòng thủ: mọi shape lạ đều thành một dòng mono gọn, không bao giờ ném lỗi.
import { BRIDGE_EVENT_MARKER, BUS_MCP_SERVER_NAME, parseWakeTurn } from "@claude-bridge/protocol";
import type { SessionEventRecord, WakeEvent } from "@claude-bridge/protocol";
import { BUS_TOOL_PREFIX } from "../config";
import { basename, compactJson, truncate } from "../lib/format";

export interface ToolResult {
  isError: boolean;
  text: string;
}

export interface ToolCall {
  id: string | null;
  /** Tên đầy đủ, ví dụ `mcp__bridge-bus__assign_task`. */
  name: string;
  /** Tên rút gọn để hiển thị, ví dụ `assign_task`. */
  displayName: string;
  input: Record<string, unknown>;
  result: ToolResult | null;
  ts: string;
}

export interface SystemTurn {
  key: string;
  ts: string;
  text: string;
  /** null khi turn hệ thống không theo định dạng [bridge-event]. */
  events: WakeEvent[] | null;
}

export type StreamItem =
  | { kind: "user"; key: string; ts: string; text: string }
  | { kind: "agent"; key: string; ts: string; text: string }
  | { kind: "tool"; key: string; ts: string; call: ToolCall }
  | { kind: "tool-group"; key: string; ts: string; calls: ToolCall[] }
  | { kind: "system-turns"; key: string; ts: string; turns: SystemTurn[] }
  | { kind: "wake-warning"; key: string; ts: string; event: WakeEvent }
  | { kind: "notice"; key: string; ts: string; tone: "dim" | "warn"; text: string }
  | { kind: "raw"; key: string; ts: string; text: string };

export interface BuildOptions {
  /** Gộp các tool đọc liên tiếp thành một dòng (planner). */
  collapseReadOnly: boolean;
  /** Hiện dòng kết thúc turn thành công (event `result`). */
  showResults?: boolean;
}

// ------------------------------------------------------------------ helpers

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

/** Nội dung message: string hoặc mảng block. */
function contentBlocks(message: unknown): unknown[] {
  if (!isObj(message)) return [];
  const c = message.content;
  if (typeof c === "string") return [{ type: "text", text: c }];
  return Array.isArray(c) ? c : [];
}

function blockText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (isObj(b) && typeof b.text === "string" ? b.text : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

const READ_ONLY_BUILTINS = new Set(["Read", "Grep", "Glob", "LS", "NotebookRead", "WebFetch", "WebSearch", "TodoRead"]);
// Cho phép tiền tố tên server trong tên tool, ví dụ `jira_get_issue`.
const READ_ONLY_MCP_RE = /^(?:[a-z]+_)?(get|search|list|read|fetch|find|view|lookup)(_|[A-Z]|$)/i;

export function splitMcpName(name: string): { server: string; tool: string } | null {
  if (!name.startsWith("mcp__")) return null;
  const parts = name.split("__");
  if (parts.length < 3) return null;
  return { server: parts[1] ?? "", tool: parts.slice(2).join("__") };
}

export function isReadOnlyTool(name: string): boolean {
  if (READ_ONLY_BUILTINS.has(name)) return true;
  const mcp = splitMcpName(name);
  if (!mcp || mcp.server === BUS_MCP_SERVER_NAME) return false;
  return READ_ONLY_MCP_RE.test(mcp.tool);
}

export function toolDisplayName(name: string): string {
  if (name.startsWith(BUS_TOOL_PREFIX)) return name.slice(BUS_TOOL_PREFIX.length);
  return splitMcpName(name)?.tool ?? name;
}

const CHIP_MAX_ARGS = 4;
const CHIP_ARG_MAX = 40;

function primitiveArgs(input: Obj, maxLen = CHIP_ARG_MAX): string[] {
  const out: string[] = [];
  for (const v of Object.values(input)) {
    if (typeof v === "string") out.push(truncate(v.replace(/\s+/g, " "), maxLen));
    else if (typeof v === "number" || typeof v === "boolean") out.push(String(v));
    if (out.length >= CHIP_MAX_ARGS) break;
  }
  return out;
}

/** `mcp__bridge-bus__assign_task {worker_id, ticket_key}` -> `assign_task(w-sh-01, SH-129)`. */
export function formatToolChip(call: Pick<ToolCall, "displayName" | "input">): string {
  return `${call.displayName}(${primitiveArgs(call.input).join(", ")})`;
}

/** Mục tiêu chính của tool đọc (tên file, pattern...), dùng trong dòng gộp. */
export function toolTarget(name: string, input: Obj): string {
  const filePath = str(input.file_path) ?? str(input.notebook_path) ?? str(input.path);
  switch (name) {
    case "Read":
    case "NotebookRead":
    case "LS":
      return basename(filePath) || compactJson(input, 40);
    case "Grep":
    case "Glob":
      return str(input.pattern) ?? compactJson(input, 40);
    case "WebFetch":
      return str(input.url) ?? compactJson(input, 40);
    case "WebSearch":
      return str(input.query) ?? compactJson(input, 40);
    default: {
      const args = primitiveArgs(input, 30);
      return [toolDisplayName(name), ...args.slice(0, 1)].join(" ");
    }
  }
}

const GROUP_DETAIL_SHOWN = 2;

/** "Đã đọc 6 file" + "WeaponController.cs, ReloadState.cs, +4". */
export function summarizeToolGroup(calls: ToolCall[]): { label: string; detail: string } {
  const allRead = calls.every((c) => c.name === "Read");
  const label = allRead ? `Đã đọc ${calls.length} file` : `${calls.length} thao tác đọc`;
  const targets: string[] = [];
  for (const c of calls) {
    const t = toolTarget(c.name, c.input);
    if (t && !targets.includes(t)) targets.push(t);
  }
  const shown = targets.slice(0, GROUP_DETAIL_SHOWN);
  const rest = targets.length - shown.length;
  return { label, detail: rest > 0 ? `${shown.join(", ")}, +${rest}` : shown.join(", ") };
}

export function wakeEventTypes(turns: SystemTurn[]): string[] {
  const types: string[] = [];
  for (const t of turns) {
    const list = t.events ? t.events.map((e) => e.type) : ["system"];
    for (const ty of list) if (!types.includes(ty)) types.push(ty);
  }
  return types;
}

export function wakeWarningText(ev: WakeEvent): string {
  return [ev.ticket_key ?? ev.task_id, ev.category].filter(Boolean).join(", ") || "không rõ ticket";
}

function isSystemTurn(rec: SessionEventRecord, text: string): boolean {
  return rec.origin === "system" || text.startsWith(BRIDGE_EVENT_MARKER);
}

// ------------------------------------------------------------------ build

type RawItem = StreamItem | { kind: "system-turn"; key: string; ts: string; turn: SystemTurn };

function collectToolResults(records: SessionEventRecord[]): Map<string, ToolResult> {
  const results = new Map<string, ToolResult>();
  for (const rec of records) {
    const ev = rec.event;
    if (!isObj(ev) || ev.type !== "user") continue;
    for (const b of contentBlocks(ev.message)) {
      if (isObj(b) && b.type === "tool_result" && typeof b.tool_use_id === "string") {
        results.set(b.tool_use_id, { isError: b.is_error === true, text: blockText(b.content) });
      }
    }
  }
  return results;
}

function resultLine(ev: Obj): { isError: boolean; text: string } {
  const isError = ev.is_error === true || (typeof ev.subtype === "string" && ev.subtype !== "success");
  const parts: string[] = [isError ? `Turn lỗi (${str(ev.subtype) ?? "error"})` : "Kết thúc turn"];
  if (typeof ev.num_turns === "number") parts.push(`${ev.num_turns} lượt`);
  if (typeof ev.total_cost_usd === "number") parts.push(`$${ev.total_cost_usd.toFixed(2)}`);
  if (isError && typeof ev.result === "string") parts.push(truncate(ev.result, 120));
  return { isError, text: parts.join(" · ") };
}

function rawItemsForRecord(rec: SessionEventRecord, results: Map<string, ToolResult>, opts: BuildOptions): RawItem[] {
  const ev = rec.event;
  const ts = rec.ts;
  const k = (i: number | string) => `${rec.id}:${i}`;
  if (!isObj(ev)) return [{ kind: "raw", key: k(0), ts, text: compactJson(ev) }];
  const type = str(ev.type) ?? "";

  switch (type) {
    case "user_text": {
      const text = str(ev.text) ?? "";
      if (isSystemTurn(rec, text)) {
        return [{ kind: "system-turn", key: k(0), ts, turn: { key: k(0), ts, text, events: parseWakeTurn(text) } }];
      }
      return [{ kind: "user", key: k(0), ts, text }];
    }

    case "assistant": {
      const items: RawItem[] = [];
      contentBlocks(ev.message).forEach((b, i) => {
        if (!isObj(b)) return;
        if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
          items.push({ kind: "agent", key: k(i), ts, text: b.text });
        } else if (b.type === "tool_use" && typeof b.name === "string") {
          const id = str(b.id);
          items.push({
            kind: "tool",
            key: k(i),
            ts,
            call: {
              id,
              name: b.name,
              displayName: toolDisplayName(b.name),
              input: isObj(b.input) ? b.input : {},
              result: id ? (results.get(id) ?? null) : null,
              ts,
            },
          });
        }
        // thinking / redacted_thinking: bỏ qua.
      });
      return items;
    }

    case "user": {
      // tool_result đã gắn vào tool_use; phần text còn lại hiện theo origin.
      const text = contentBlocks(ev.message)
        .filter((b) => isObj(b) && b.type === "text")
        .map((b) => str((b as Obj).text) ?? "")
        .join("\n")
        .trim();
      if (!text) return [];
      if (isSystemTurn(rec, text)) {
        return [{ kind: "system-turn", key: k(0), ts, turn: { key: k(0), ts, text, events: parseWakeTurn(text) } }];
      }
      if (rec.origin === "user") return [{ kind: "user", key: k(0), ts, text }];
      return [{ kind: "raw", key: k(0), ts, text: `user: ${truncate(text, 160)}` }];
    }

    case "result": {
      const { isError, text } = resultLine(ev);
      if (!isError && !opts.showResults) return [];
      return [{ kind: "notice", key: k(0), ts, tone: isError ? "warn" : "dim", text }];
    }

    case "system": {
      if (ev.subtype === "init") {
        const model = str(ev.model);
        return [{ kind: "notice", key: k(0), ts, tone: "dim", text: `Session khởi tạo${model ? ` · ${model}` : ""}` }];
      }
      return [{ kind: "raw", key: k(0), ts, text: `system${ev.subtype ? `.${String(ev.subtype)}` : ""}` }];
    }

    case "rate_limit_event": {
      const info = isObj(ev.rate_limit_info) ? ev.rate_limit_info : ev;
      const status = str(info.status) ?? "";
      if (status === "allowed") return [];
      return [{ kind: "notice", key: k(0), ts, tone: "warn", text: `Rate limit${status ? `: ${status}` : ""}` }];
    }

    case "stream_event":
      return [];

    default:
      return [{ kind: "raw", key: k(0), ts, text: `${type || "?"}: ${compactJson(ev, 140)}` }];
  }
}

export function buildStreamItems(records: SessionEventRecord[], opts: BuildOptions): StreamItem[] {
  const results = collectToolResults(records);
  const raw: RawItem[] = [];
  for (const rec of records) {
    try {
      raw.push(...rawItemsForRecord(rec, results, opts));
    } catch {
      raw.push({ kind: "raw", key: `${rec.id}:err`, ts: rec.ts, text: compactJson(rec.event) });
    }
  }

  const out: StreamItem[] = [];
  for (const item of raw) {
    const last = out[out.length - 1];
    if (item.kind === "system-turn") {
      if (last?.kind === "system-turns") last.turns.push(item.turn);
      else out.push({ kind: "system-turns", key: item.key, ts: item.ts, turns: [item.turn] });
      continue;
    }
    if (opts.collapseReadOnly && item.kind === "tool" && isReadOnlyTool(item.call.name)) {
      if (last?.kind === "tool-group") last.calls.push(item.call);
      else out.push({ kind: "tool-group", key: item.key, ts: item.ts, calls: [item.call] });
      continue;
    }
    out.push(item);
  }

  // task.failed trong turn hệ thống hiện thành cảnh báo riêng ngay sau dòng gộp.
  const final: StreamItem[] = [];
  for (const item of out) {
    final.push(item);
    if (item.kind !== "system-turns") continue;
    for (const turn of item.turns) {
      (turn.events ?? []).forEach((e, i) => {
        if (e.type === "task.failed") final.push({ kind: "wake-warning", key: `${turn.key}:w${i}`, ts: turn.ts, event: e });
      });
    }
  }
  return final;
}

// ------------------------------------------------------------------ task log rows

export type LogTone = "accent" | "dim" | "warn" | "normal";

export interface LogRow {
  key: string;
  ts: string;
  source: string;
  detail: string;
  tone: LogTone;
}

const LOG_TEXT_MAX = 400;

/** Nguồn + mô tả một tool call cho luồng session của task ("jira", "get_issue SH-129"). */
export function describeTool(name: string, input: Obj): { source: string; detail: string; mcp: boolean } {
  const mcp = splitMcpName(name);
  if (mcp) {
    const source =
      mcp.server === BUS_MCP_SERVER_NAME
        ? "bus"
        : /jira|atlassian/i.test(mcp.server)
          ? "jira"
          : /gitlab/i.test(mcp.server)
            ? "gitlab"
            : mcp.server;
    return { source, detail: [mcp.tool, ...primitiveArgs(input)].join(" "), mcp: true };
  }
  const filePath = str(input.file_path) ?? str(input.notebook_path);
  let detail: string;
  switch (name) {
    case "Read":
    case "Edit":
    case "Write":
    case "MultiEdit":
    case "NotebookEdit":
    case "NotebookRead":
      detail = basename(filePath) || compactJson(input, 80);
      break;
    case "Grep":
    case "Glob": {
      const pattern = str(input.pattern) ?? "";
      const path = str(input.path);
      detail = path ? `${pattern} trong ${path}` : pattern;
      break;
    }
    case "LS":
      detail = str(input.path) ?? "";
      break;
    case "Bash":
      detail = truncate(str(input.command) ?? "", 160);
      break;
    case "WebFetch":
      detail = str(input.url) ?? "";
      break;
    case "WebSearch":
      detail = str(input.query) ?? "";
      break;
    default:
      detail = primitiveArgs(input).join(" ") || compactJson(input, 80);
  }
  return { source: name, detail, mcp: false };
}

export function buildLogRows(records: SessionEventRecord[]): LogRow[] {
  const results = collectToolResults(records);
  const rows: LogRow[] = [];
  for (const rec of records) {
    try {
      const ev = rec.event;
      const k = (i: number | string) => `${rec.id}:${i}`;
      if (!isObj(ev)) {
        rows.push({ key: k(0), ts: rec.ts, source: "?", detail: compactJson(ev), tone: "dim" });
        continue;
      }
      const type = str(ev.type) ?? "";
      if (type === "assistant") {
        contentBlocks(ev.message).forEach((b, i) => {
          if (!isObj(b)) return;
          if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
            rows.push({ key: k(i), ts: rec.ts, source: "agent", detail: truncate(b.text, LOG_TEXT_MAX), tone: "normal" });
          } else if (b.type === "tool_use" && typeof b.name === "string") {
            const d = describeTool(b.name, isObj(b.input) ? b.input : {});
            const res = typeof b.id === "string" ? results.get(b.id) : undefined;
            rows.push({
              key: k(i),
              ts: rec.ts,
              source: d.source,
              detail: res?.isError ? `${d.detail} (lỗi: ${truncate(res.text, 120)})` : d.detail,
              tone: res?.isError ? "warn" : d.mcp ? "accent" : "dim",
            });
          }
        });
      } else if (type === "user_text") {
        rows.push({
          key: k(0),
          ts: rec.ts,
          source: rec.origin === "system" ? "system" : "prompt",
          detail: truncate(str(ev.text) ?? "", LOG_TEXT_MAX),
          tone: "dim",
        });
      } else if (type === "result") {
        const { isError, text } = resultLine(ev);
        rows.push({ key: k(0), ts: rec.ts, source: "result", detail: text, tone: isError ? "warn" : "dim" });
      } else if (type === "system") {
        rows.push({
          key: k(0),
          ts: rec.ts,
          source: "system",
          detail: [str(ev.subtype), str(ev.model)].filter(Boolean).join(" · "),
          tone: "dim",
        });
      } else if (type === "rate_limit_event") {
        const info = isObj(ev.rate_limit_info) ? ev.rate_limit_info : ev;
        rows.push({ key: k(0), ts: rec.ts, source: "rate", detail: str(info.status) ?? compactJson(info, 80), tone: "warn" });
      } else if (type === "user" || type === "stream_event") {
        // tool_result đã gắn vào dòng tool.
      } else {
        rows.push({ key: k(0), ts: rec.ts, source: type || "?", detail: compactJson(ev, 140), tone: "dim" });
      }
    } catch {
      rows.push({ key: `${rec.id}:err`, ts: rec.ts, source: "?", detail: compactJson(rec.event), tone: "dim" });
    }
  }
  return rows;
}
