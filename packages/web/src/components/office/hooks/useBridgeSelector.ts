import { useCallback, useContext, useSyncExternalStore } from "react";
import { BridgeContext } from "../../../hooks/bridge-context";
import type { Store } from "../../../state/store";
import type { AppState } from "../../../state/types";

function useBridgeContextValue() {
  const ctx = useContext(BridgeContext);
  if (!ctx) throw new Error("BridgeContext chưa được cung cấp");
  return ctx;
}

export function useBridgeStore(): Store {
  return useBridgeContextValue().store;
}

/**
 * Đăng ký một lát của AppState. `select` phải trả tham chiếu lấy thẳng từ state (không tạo object mới):
 * reducer giữ nguyên tham chiếu các nhánh không đổi, nên component không render khi lát đó không đổi
 * (ví dụ khi chat đang stream chỉ `streams` đổi).
 */
export function useBridgeSelector<T>(select: (state: AppState) => T): T {
  const { store } = useBridgeContextValue();
  const getSnapshot = useCallback(() => select(store.getState()), [store, select]);
  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
}
