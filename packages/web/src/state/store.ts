// Store đồng bộ quanh reducer thuần. Service đọc state mới nhất ngay sau dispatch
// (React useReducer không đảm bảo điều này giữa các message WS liên tiếp).
import { initialState, reducer } from "./reducer";
import type { Action, AppState } from "./types";

export interface Store {
  getState(): AppState;
  dispatch(action: Action): void;
  subscribe(listener: () => void): () => void;
}

export function createStore(initial: AppState = initialState): Store {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    getState: () => state,
    dispatch(action) {
      const next = reducer(state, action);
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
