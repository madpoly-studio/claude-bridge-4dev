import { createContext, useContext, useSyncExternalStore } from "react";
import type { BridgeActions } from "../services/bridge-actions";
import type { Store } from "../state/store";
import type { AppState } from "../state/types";

export interface BridgeContextValue {
  store: Store;
  actions: BridgeActions;
  demo: boolean;
}

export const BridgeContext = createContext<BridgeContextValue | null>(null);

function useBridgeContext(): BridgeContextValue {
  const ctx = useContext(BridgeContext);
  if (!ctx) throw new Error("BridgeContext chưa được cung cấp");
  return ctx;
}

export function useBridgeState(): AppState {
  const { store } = useBridgeContext();
  return useSyncExternalStore(store.subscribe, store.getState, store.getState);
}

export function useBridgeActions(): BridgeActions {
  return useBridgeContext().actions;
}

export function useIsDemo(): boolean {
  return useBridgeContext().demo;
}
