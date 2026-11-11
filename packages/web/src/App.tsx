import { useState } from "react";
import { AppShell } from "./components/AppShell";
import { createDemoState } from "./demo/fixtures";
import { BridgeContext } from "./hooks/bridge-context";
import type { BridgeContextValue } from "./hooks/bridge-context";
import { isDemoMode } from "./lib/mode";
import { DemoBridgeService } from "./services/demo-bridge-service";
import { LiveBridgeService } from "./services/live-bridge-service";
import { createStore } from "./state/store";

interface AppProps {
  /** Mặc định đọc `?demo=1` trên URL. */
  demo?: boolean;
}

export function App({ demo = isDemoMode() }: AppProps) {
  const [ctx] = useState<BridgeContextValue>(() => {
    const store = createStore(demo ? createDemoState() : undefined);
    const actions = demo ? new DemoBridgeService(store) : new LiveBridgeService(store);
    return { store, actions, demo };
  });

  return (
    <BridgeContext.Provider value={ctx}>
      <AppShell />
    </BridgeContext.Provider>
  );
}
