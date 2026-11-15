import { describe, expect, it } from "vitest";
import { busEvent, makeTask } from "../../../__tests__/helpers";
import { FX_MS } from "../constants";
import { CANCELLED_TEXT, collectProgress, detectTransitions, fxReducer, INITIAL_FX, nextExpiry } from "./effects";
import type { SceneFxState, TaskTransition } from "./effects";

const NOW = 1_000_000;

const transition = (p: Partial<TaskTransition> & Pick<TaskTransition, "to">): TaskTransition => ({
  workerId: "w-1",
  taskId: "t-1",
  ticketKey: "SH-1",
  failCategory: null,
  ...p,
});

describe("detectTransitions", () => {
  const running = makeTask({ task_id: "t-1", ticket_key: "SH-1" });

  it("task chưa terminal → terminal sinh một chuyển tiếp", () => {
    const next = { "t-1": { ...running, state: "failed" as const, fail_category: "build_failed" as const } };
    expect(detectTransitions({ "t-1": running }, next)).toEqual([
      { workerId: "w-1", taskId: "t-1", ticketKey: "SH-1", to: "failed", failCategory: "build_failed" },
    ]);
  });

  it("task mới xuất hiện đã terminal (snapshot, replay cũ) thì bỏ qua", () => {
    expect(detectTransitions({}, { "t-1": { ...running, state: "completed" } })).toEqual([]);
  });

  it("task đã terminal từ trước, hoặc vẫn đang chạy, không sinh gì", () => {
    const done = { ...running, state: "completed" as const };
    expect(detectTransitions({ "t-1": done }, { "t-1": { ...done, summary: "x" } })).toEqual([]);
    expect(detectTransitions({ "t-1": running }, { "t-1": { ...running, phase: "testing" } })).toEqual([]);
    const same = { "t-1": running };
    expect(detectTransitions(same, same)).toEqual([]);
  });
});

describe("collectProgress", () => {
  const progress = (seq: number, worker: string, message: unknown) => busEvent(seq, "task.progress", { worker_id: worker, payload: { message } });

  it("chỉ lấy event sau con trỏ, mỗi worker cái mới nhất, và dời con trỏ", () => {
    const events = [progress(1, "w-1", "cũ"), progress(2, "w-1", "a"), progress(3, "w-2", "b"), progress(4, "w-1", " c ")];
    const out = collectProgress(events, 1);
    expect(out.cursorSeq).toBe(4);
    expect(out.items).toEqual(
      expect.arrayContaining([
        { workerId: "w-1", text: "c" },
        { workerId: "w-2", text: "b" },
      ]),
    );
    expect(out.items).toHaveLength(2);
  });

  it("gọi lại với cùng con trỏ mới (seq trùng) không sinh thêm gì", () => {
    const events = [progress(1, "w-1", "a")];
    const first = collectProgress(events, 0);
    expect(collectProgress(events, first.cursorSeq)).toEqual({ items: [], cursorSeq: 1 });
  });

  it("bỏ event không phải progress, thiếu worker, hoặc message rỗng / không phải chuỗi", () => {
    const events = [
      busEvent(1, "task.started", { worker_id: "w-1", payload: { message: "x" } }),
      progress(2, "w-1", ""),
      progress(3, "w-2", 42),
      busEvent(4, "task.progress", { worker_id: null, payload: { message: "x" } }),
    ];
    expect(collectProgress(events, 0)).toEqual({ items: [], cursorSeq: 4 });
  });
});

describe("fxReducer", () => {
  it("completed → happy 1,8 s và một giấy note của worker đó", () => {
    const s = fxReducer(INITIAL_FX, { type: "transitions", items: [transition({ to: "completed" })], now: NOW });
    expect(s.byWorker["w-1"]!.pose).toMatchObject({ kind: "happy", detail: "SH-1", taskId: "t-1", until: NOW + FX_MS.happy });
    expect(s.byWorker["w-1"]!.bubble).toBeNull();
    // Note chỉ mang worker_id: cảnh tự tra bàn worker đang ngồi (worker không có bàn thì cảnh không vẽ note).
    expect(s.notes).toEqual([expect.objectContaining({ workerId: "w-1", until: NOW + FX_MS.note })]);
  });

  it("failed → error 4 s kèm bong bóng fail_category", () => {
    const s = fxReducer(INITIAL_FX, { type: "transitions", items: [transition({ to: "failed", failCategory: "timeout" })], now: NOW });
    expect(s.byWorker["w-1"]!.pose).toMatchObject({ kind: "error", detail: "timeout", until: NOW + FX_MS.error });
    expect(s.byWorker["w-1"]!.bubble).toMatchObject({ text: "timeout", tone: "fail", until: NOW + FX_MS.error });
    expect(s.notes).toEqual([]);
  });

  it("cancelled → chỉ bong bóng trung tính, không có tư thế lỗi", () => {
    const s = fxReducer(INITIAL_FX, { type: "transitions", items: [transition({ to: "cancelled" })], now: NOW });
    expect(s.byWorker["w-1"]).toMatchObject({ pose: null, bubble: { text: CANCELLED_TEXT, tone: "info", until: NOW + FX_MS.cancelBubble } });
  });

  it("progress → bong bóng 6 s; bong bóng mới thay bong bóng cũ, giữ nguyên tư thế", () => {
    let s = fxReducer(INITIAL_FX, { type: "progress", items: [{ workerId: "w-1", text: "a" }], now: NOW });
    const firstId = s.byWorker["w-1"]!.bubble!.id;
    s = fxReducer(s, { type: "progress", items: [{ workerId: "w-1", text: "b" }], now: NOW + 100 });
    expect(s.byWorker["w-1"]!.bubble).toMatchObject({ text: "b", tone: "progress", until: NOW + 100 + FX_MS.bubble });
    expect(s.byWorker["w-1"]!.bubble!.id).not.toBe(firstId);
  });

  it("id của hiệu ứng tăng dần, không trùng", () => {
    const s = fxReducer(INITIAL_FX, {
      type: "transitions",
      items: [transition({ to: "completed" }), transition({ to: "failed", workerId: "w-2", taskId: "t-2" })],
     
      now: NOW,
    });
    const ids = [s.byWorker["w-1"]!.pose!.id, s.notes[0]!.id, s.byWorker["w-2"]!.pose!.id, s.byWorker["w-2"]!.bubble!.id];
    expect(new Set(ids).size).toBe(4);
    expect(s.nextId).toBeGreaterThan(Math.max(...ids));
  });

  it("expire gỡ đúng mục hết hạn; không còn gì đổi thì trả đúng tham chiếu cũ", () => {
    let s: SceneFxState = fxReducer(INITIAL_FX, { type: "transitions", items: [transition({ to: "completed" })], now: NOW });
    expect(fxReducer(s, { type: "expire", now: NOW + 10 })).toBe(s);
    expect(nextExpiry(s)).toBe(NOW + FX_MS.note);

    s = fxReducer(s, { type: "expire", now: NOW + FX_MS.note });
    expect(s.notes).toEqual([]);
    expect(s.byWorker["w-1"]!.pose?.kind).toBe("happy");
    expect(nextExpiry(s)).toBe(NOW + FX_MS.happy);

    s = fxReducer(s, { type: "expire", now: NOW + FX_MS.happy });
    expect(s.byWorker).toEqual({});
    expect(nextExpiry(s)).toBeNull();
    expect(fxReducer(s, { type: "expire", now: NOW + 99_999 })).toBe(s);
  });

  it("loạt rỗng và reset khi trống không tạo state mới", () => {
    expect(fxReducer(INITIAL_FX, { type: "transitions", items: [], now: NOW })).toBe(INITIAL_FX);
    expect(fxReducer(INITIAL_FX, { type: "progress", items: [], now: NOW })).toBe(INITIAL_FX);
    expect(fxReducer(INITIAL_FX, { type: "reset" })).toBe(INITIAL_FX);
    const s = fxReducer(INITIAL_FX, { type: "progress", items: [{ workerId: "w-1", text: "a" }], now: NOW });
    expect(fxReducer(s, { type: "reset" })).toMatchObject({ byWorker: {}, notes: [] });
  });
});
