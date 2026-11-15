import { useEffect, useMemo, useSyncExternalStore } from "react";
import { collectProgress, detectTransitions, fxReducer, INITIAL_FX, nextExpiry } from "../model/effects";
import type { FxAction, SceneFxState } from "../model/effects";
import { useBridgeStore } from "./useBridgeSelector";

interface FxStore {
  get(): SceneFxState;
  dispatch(action: FxAction): void;
  subscribe(listener: () => void): () => void;
}

/**
 * Store nhỏ quanh fxReducer. Dùng useSyncExternalStore (không dùng useReducer) để hiệu ứng được vẽ trong CÙNG lượt render
 * với thay đổi của tasks / workers: nếu trễ một lượt, robot vừa xong task sẽ kịp quay đi về khu Relax rồi mới quay lại ăn mừng.
 */
function createFxStore(): FxStore {
  let state = INITIAL_FX;
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    dispatch(action) {
      const next = fxReducer(state, action);
      if (next === state) return;
      state = next;
      for (const l of listeners) l();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/**
 * Nối store của bridge với hiệu ứng tạm. Mốc so sánh lấy lúc mount, nên chuyện đã xảy ra trước khi vào view
 * (hoặc trước khi refresh) không sinh hiệu ứng. Snapshot mới và replay sau reconnect chỉ tái lập mốc.
 */
export function useOfficeFx(): SceneFxState {
  const store = useBridgeStore();
  const fxStore = useMemo(createFxStore, []);
  const fx = useSyncExternalStore(fxStore.subscribe, fxStore.get, fxStore.get);

  useEffect(() => {
    const first = store.getState();
    let prevTasks = first.tasks;
    let prevEvents = first.events;
    let cursorSeq = first.lastSeq;
    let snapshotSeq = first.snapshotSeq;

    return store.subscribe(() => {
      const state = store.getState();
      // Chat stream chỉ đổi `streams`: ba phép so sánh rồi thoát.
      if (state.tasks === prevTasks && state.events === prevEvents && state.snapshotSeq === snapshotSeq) return;

      const rebase = state.snapshotSeq !== snapshotSeq || state.connection.phase !== "live";
      if (rebase) {
        prevTasks = state.tasks;
        prevEvents = state.events;
        cursorSeq = Math.max(cursorSeq, state.lastSeq);
        snapshotSeq = state.snapshotSeq;
        return;
      }

      const now = Date.now();
      if (state.tasks !== prevTasks) {
        const items = detectTransitions(prevTasks, state.tasks);
        prevTasks = state.tasks;
        if (items.length > 0) fxStore.dispatch({ type: "transitions", items, now });
      }
      if (state.events !== prevEvents) {
        prevEvents = state.events;
        const progress = collectProgress(state.events, cursorSeq);
        cursorSeq = progress.cursorSeq;
        if (progress.items.length > 0) fxStore.dispatch({ type: "progress", items: progress.items, now });
      }
    });
  }, [store, fxStore]);

  // Một timer tới hạn gần nhất; state đổi thì đặt lại.
  useEffect(() => {
    const at = nextExpiry(fx);
    if (at === null) return;
    const id = setTimeout(() => fxStore.dispatch({ type: "expire", now: Date.now() }), Math.max(0, at - Date.now()) + 1);
    return () => clearTimeout(id);
  }, [fx, fxStore]);

  return fx;
}
