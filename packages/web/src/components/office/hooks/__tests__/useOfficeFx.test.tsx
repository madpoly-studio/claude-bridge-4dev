import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { Task } from "@claude-bridge/protocol";
import { busEvent, makeTask, makeWorker, msg, snapshot } from "../../../../__tests__/helpers";
import { BridgeContext } from "../../../../hooks/bridge-context";
import type { BridgeContextValue } from "../../../../hooks/bridge-context";
import type { BridgeActions } from "../../../../services/bridge-actions";
import { createStore } from "../../../../state/store";
import type { Store } from "../../../../state/store";
import { INITIAL_CONNECTION } from "../../../../ws/client";
import type { ConnectionPhase } from "../../../../ws/client";
import { FX_MS } from "../../constants";
import { INITIAL_FX } from "../../model/effects";
import { useOfficeFx } from "../useOfficeFx";

const running = (id: string, worker: string): Task => makeTask({ task_id: id, ticket_key: `SH-${id}`, worker_id: worker });
const done = (id: string, worker: string): Task => ({ ...running(id, worker), state: "completed" });
const failed = (id: string, worker: string): Task => ({ ...running(id, worker), state: "failed", fail_category: "build_failed" });

const setPhase = (store: Store, phase: ConnectionPhase) => store.dispatch({ type: "local/connection", connection: { ...INITIAL_CONNECTION, phase } });

/** Store đã live với w-1 đang chạy t-1, w-2 đang chạy t-2, và t-0 đã xong từ trước. */
function liveStore(): Store {
  const store = createStore();
  setPhase(store, "live");
  store.dispatch(
    snapshot({
      workers: [makeWorker({ worker_id: "w-1", state: "busy", current_task_id: "t-1" }), makeWorker({ worker_id: "w-2", state: "busy", current_task_id: "t-2" })],
      tasks: [running("t-1", "w-1"), running("t-2", "w-2"), done("t-0", "w-1")],
      last_seq: 10,
    }),
  );
  store.dispatch(msg("replay.done", { last_seq: 10 }));
  return store;
}

function mount(store: Store) {
  const value: BridgeContextValue = { store, actions: {} as BridgeActions, demo: false };
  const wrapper = ({ children }: { children: ReactNode }) => <BridgeContext.Provider value={value}>{children}</BridgeContext.Provider>;
  return renderHook(() => useOfficeFx(), { wrapper });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useOfficeFx", () => {
  it("lúc mount không sinh hiệu ứng nào cho chuyện đã xảy ra từ trước, và không đặt timer", () => {
    const { result } = mount(liveStore());
    expect(result.current).toBe(INITIAL_FX);
    act(() => void vi.advanceTimersByTime(FX_MS.bubble * 2));
    expect(result.current).toBe(INITIAL_FX);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("task hoàn thành: happy + giấy note xuất hiện rồi tự hết hạn (note trước, happy sau)", () => {
    const store = liveStore();
    const { result } = mount(store);
    act(() => store.dispatch(msg("task.updated", done("t-1", "w-1"))));
    expect(result.current.byWorker["w-1"]?.pose).toMatchObject({ kind: "happy", taskId: "t-1" });
    expect(result.current.notes).toEqual([expect.objectContaining({ workerId: "w-1" })]);
    expect(result.current.byWorker["w-2"]).toBeUndefined();

    act(() => void vi.advanceTimersByTime(FX_MS.note + 10));
    expect(result.current.notes).toEqual([]);
    expect(result.current.byWorker["w-1"]?.pose?.kind).toBe("happy");

    act(() => void vi.advanceTimersByTime(FX_MS.happy));
    expect(result.current.byWorker).toEqual({});
    expect(vi.getTimerCount()).toBe(0);
  });

  it("task lỗi: tư thế error kèm bong bóng fail_category, hết sau 4 s", () => {
    const store = liveStore();
    const { result } = mount(store);
    act(() => store.dispatch(msg("task.updated", failed("t-2", "w-2"))));
    expect(result.current.byWorker["w-2"]).toMatchObject({ pose: { kind: "error" }, bubble: { text: "build_failed", tone: "fail" } });
    expect(result.current.notes).toEqual([]);
    act(() => void vi.advanceTimersByTime(FX_MS.error + 10));
    expect(result.current.byWorker).toEqual({});
  });

  it("task.progress mới: bong bóng 6 s; event cũ hơn con trỏ lúc mount bị bỏ qua", () => {
    const store = liveStore();
    const { result } = mount(store);
    const progress = (seq: number, message: string) =>
      msg("bus.event", busEvent(seq, "task.progress", { worker_id: "w-1", task_id: "t-1", payload: { message } }));
    // seq 5 <= lastSeq 10 lúc mount: replay cũ, không sinh bong bóng.
    act(() => store.dispatch(progress(5, "cũ")));
    expect(result.current).toBe(INITIAL_FX);

    act(() => store.dispatch(progress(11, "Đang chạy test")));
    expect(result.current.byWorker["w-1"]?.bubble).toMatchObject({ text: "Đang chạy test", tone: "progress" });
    act(() => void vi.advanceTimersByTime(FX_MS.bubble + 10));
    expect(result.current.byWorker).toEqual({});
  });

  it("mất kết nối rồi nối lại: thay đổi lúc chưa live và snapshot mới chỉ tái lập mốc, không sinh hiệu ứng", () => {
    const store = liveStore();
    const { result } = mount(store);

    act(() => setPhase(store, "reconnecting"));
    // Task kết thúc và progress tới trong lúc chưa live (replay mang về).
    act(() => store.dispatch(msg("task.updated", done("t-1", "w-1"))));
    act(() =>
      store.dispatch(msg("bus.event", busEvent(12, "task.progress", { worker_id: "w-2", task_id: "t-2", payload: { message: "trong lúc mất mạng" } }))),
    );
    act(() => setPhase(store, "syncing"));
    act(() =>
      store.dispatch(
        snapshot({
          workers: [makeWorker({ worker_id: "w-1" }), makeWorker({ worker_id: "w-2" })],
          tasks: [done("t-1", "w-1"), failed("t-2", "w-2"), done("t-0", "w-1")],
          last_seq: 20,
        }),
      ),
    );
    act(() => setPhase(store, "live"));
    expect(result.current).toBe(INITIAL_FX);
    expect(vi.getTimerCount()).toBe(0);

    // Sau khi live lại, chuyển tiếp mới vẫn sinh hiệu ứng.
    act(() => store.dispatch(msg("task.updated", running("t-3", "w-1"))));
    act(() => store.dispatch(msg("task.updated", done("t-3", "w-1"))));
    expect(result.current.byWorker["w-1"]?.pose).toMatchObject({ kind: "happy", taskId: "t-3" });
  });

  it("rời view: dọn timer hết hạn và ngừng nghe store", () => {
    const store = liveStore();
    const { result, unmount } = mount(store);
    act(() => store.dispatch(msg("task.updated", done("t-1", "w-1"))));
    expect(result.current.notes).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
    expect(() => store.dispatch(msg("task.updated", failed("t-2", "w-2")))).not.toThrow();
  });
});
