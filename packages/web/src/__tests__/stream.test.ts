import { describe, expect, it } from "vitest";
import { formatWakeTurn } from "@claude-bridge/protocol";
import {
  buildLogRows,
  buildStreamItems,
  describeTool,
  formatToolChip,
  isReadOnlyTool,
  summarizeToolGroup,
  toolDisplayName,
  wakeEventTypes,
} from "../state/stream";
import type { StreamItem } from "../state/stream";
import { record } from "./helpers";

const assistant = (...content: unknown[]) => ({ type: "assistant", message: { content } });
const toolUse = (id: string, name: string, input: Record<string, unknown> = {}) => ({ type: "tool_use", id, name, input });
const toolResult = (tool_use_id: string, content = "ok", is_error = false) => ({
  type: "user",
  message: { content: [{ type: "tool_result", tool_use_id, content, is_error }] },
});
const kinds = (items: StreamItem[]) => items.map((i) => i.kind);

describe("tool collapsing", () => {
  const records = [
    record(1, { type: "user_text", text: "Kiểm tra lỗi" }, { origin: "user" }),
    record(2, assistant(toolUse("a", "Read", { file_path: "src/A.cs" }), toolUse("b", "Read", { file_path: "src/B.cs" }))),
    record(3, toolResult("a")),
    record(4, assistant(toolUse("c", "Grep", { pattern: "isReloading" }))),
    record(5, toolResult("b")),
    record(6, assistant({ type: "text", text: "Nguyên nhân là X" })),
    record(7, assistant(toolUse("d", "Read", { file_path: "src/C.cs" }))),
  ];

  it("gộp tool đọc liên tiếp (kể cả qua tool_result) thành một dòng", () => {
    const items = buildStreamItems(records, { collapseReadOnly: true });
    expect(kinds(items)).toEqual(["user", "tool-group", "agent", "tool-group"]);
    const group = items[1];
    expect(group?.kind === "tool-group" && group.calls.map((c) => c.name)).toEqual(["Read", "Read", "Grep"]);
  });

  it("không gộp khi tắt collapseReadOnly", () => {
    const items = buildStreamItems(records, { collapseReadOnly: false });
    expect(kinds(items)).toEqual(["user", "tool", "tool", "tool", "agent", "tool"]);
  });

  it("gắn tool_result vào tool_use theo id", () => {
    const items = buildStreamItems([record(1, assistant(toolUse("x", "Bash", { command: "make" }))), record(2, toolResult("x", "boom", true))], {
      collapseReadOnly: true,
    });
    expect(items[0]?.kind === "tool" && items[0].call.result).toEqual({ isError: true, text: "boom" });
  });

  it("tóm tắt nhóm theo mockup", () => {
    const calls = ["WeaponController.cs", "ReloadState.cs", "A.cs", "B.cs", "C.cs", "D.cs"].map((f, i) => ({
      id: String(i),
      name: "Read",
      displayName: "Read",
      input: { file_path: `Assets/${f}` },
      result: null,
      ts: "",
    }));
    expect(summarizeToolGroup(calls)).toEqual({ label: "Đã đọc 6 file", detail: "WeaponController.cs, ReloadState.cs, +4" });
    expect(summarizeToolGroup([...calls.slice(0, 1), { ...calls[1]!, name: "Grep", input: { pattern: "x" } }]).label).toBe("2 thao tác đọc");
  });

  it("phân loại tool đọc", () => {
    expect(isReadOnlyTool("Read")).toBe(true);
    expect(isReadOnlyTool("Edit")).toBe(false);
    expect(isReadOnlyTool("mcp__jira__jira_get_issue")).toBe(true);
    expect(isReadOnlyTool("mcp__jira__jira_create_issue")).toBe(false);
    expect(isReadOnlyTool("mcp__bridge-bus__list_workers")).toBe(false);
  });
});

describe("tool chip", () => {
  it("bỏ tiền tố mcp__bridge-bus__", () => {
    expect(toolDisplayName("mcp__bridge-bus__assign_task")).toBe("assign_task");
    expect(formatToolChip({ displayName: "assign_task", input: { worker_id: "w-sh-01", ticket_key: "SH-129" } })).toBe("assign_task(w-sh-01, SH-129)");
  });

  it("describeTool cho luồng task", () => {
    expect(describeTool("mcp__jira__jira_get_issue", { issue_key: "SH-129" })).toEqual({ source: "jira", detail: "jira_get_issue SH-129", mcp: true });
    expect(describeTool("mcp__bridge-bus__report_progress", { phase: "understanding" }).source).toBe("bus");
    expect(describeTool("Grep", { pattern: "reserveAmmo", path: "Assets/Scripts/UI" }).detail).toBe("reserveAmmo trong Assets/Scripts/UI");
    expect(describeTool("Read", { file_path: "a/b/HudAmmoView.cs" }).detail).toBe("HudAmmoView.cs");
  });
});

describe("wake turns", () => {
  const sys = (id: number, events: Parameters<typeof formatWakeTurn>[0]) =>
    record(id, { type: "user_text", text: formatWakeTurn(events) }, { origin: "system" });

  it("gộp turn hệ thống liên tiếp và tách task.failed thành cảnh báo", () => {
    const items = buildStreamItems(
      [
        sys(1, [{ type: "ticket.created", ticket_key: "SH-131" }]),
        sys(2, [{ type: "task.failed", task_id: "t-1", ticket_key: "SH-127", category: "build_failed" }, { type: "tick" }]),
        record(3, assistant({ type: "text", text: "OK" })),
        sys(4, [{ type: "tick" }]),
      ],
      { collapseReadOnly: false },
    );
    expect(kinds(items)).toEqual(["system-turns", "wake-warning", "agent", "system-turns"]);
    const first = items[0];
    expect(first?.kind === "system-turns" && first.turns).toHaveLength(2);
    expect(first?.kind === "system-turns" && wakeEventTypes(first.turns)).toEqual(["ticket.created", "task.failed", "tick"]);
    const warn = items[1];
    expect(warn?.kind === "wake-warning" && warn.event).toMatchObject({ ticket_key: "SH-127", category: "build_failed" });
  });

  it("nhận turn có marker [bridge-event] kể cả khi origin không phải system", () => {
    const items = buildStreamItems([record(1, { type: "user_text", text: formatWakeTurn([{ type: "tick" }]) }, { origin: "user" })], {
      collapseReadOnly: false,
    });
    expect(kinds(items)).toEqual(["system-turns"]);
  });

  it("turn hệ thống không parse được vẫn hiện, events = null", () => {
    const items = buildStreamItems([record(1, { type: "user_text", text: "nhắc nhở" }, { origin: "system" })], { collapseReadOnly: false });
    expect(items[0]?.kind === "system-turns" && items[0].turns[0]?.events).toBeNull();
    expect(items[0]?.kind === "system-turns" && wakeEventTypes(items[0].turns)).toEqual(["system"]);
  });
});

describe("render phòng thủ", () => {
  it("shape lạ thành dòng raw, không ném lỗi", () => {
    const items = buildStreamItems(
      [
        record(1, null),
        record(2, "chuỗi"),
        record(3, { type: "weird", foo: 1 }),
        record(4, { type: "assistant", message: null }),
        record(5, { type: "assistant", message: { content: [null, 5, { type: "tool_use" }] } }),
        record(6, { type: "result", subtype: "error_max_turns", is_error: true }),
        record(7, { type: "result", subtype: "success", is_error: false }),
        record(8, { type: "rate_limit_event", rate_limit_info: { status: "rejected" } }),
        record(9, { type: "stream_event" }),
      ],
      { collapseReadOnly: true },
    );
    expect(kinds(items)).toEqual(["raw", "raw", "raw", "notice", "notice"]);
    expect(items[3]?.kind === "notice" && items[3].tone).toBe("warn");
  });

  it("buildLogRows tạo dòng cho mọi loại event", () => {
    const rows = buildLogRows([
      record(1, { type: "system", subtype: "init", model: "m" }),
      record(2, assistant(toolUse("j", "mcp__jira__get_issue", { key: "SH-1" }), { type: "text", text: "xong" })),
      record(3, toolResult("j", "lỗi", true)),
      record(4, { type: "result", subtype: "success", total_cost_usd: 0.5 }),
      record(5, 42),
    ]);
    expect(rows.map((r) => r.source)).toEqual(["system", "jira", "agent", "result", "?"]);
    expect(rows[1]?.tone).toBe("warn");
  });
});
