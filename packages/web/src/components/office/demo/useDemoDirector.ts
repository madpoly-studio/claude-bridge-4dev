import { useContext, useEffect } from "react";
import { BridgeContext } from "../../../hooks/bridge-context";
import type { Store } from "../../../state/store";
import { DEMO_FX_DELAY_MS, DEMO_TICK_MS } from "../constants";
import { directorStep, fxBurst } from "./director";
import { parseScenario, scenarioActions } from "./scenarios";

/** Biến thể tĩnh chỉ áp một lần cho mỗi store, nên chuyển Dashboard ↔ Văn phòng không nhân đôi worker. */
const applied = new WeakSet<Store>();
/** Nhịp kế tiếp của từng store, để mount lại thì chạy tiếp thay vì quay về đầu vòng. */
const ticks = new WeakMap<Store, number>();

/**
 * Chỉ có tác dụng ở `?demo=1`: áp biến thể `?scenario=` và chạy kịch bản sống.
 * Mọi thay đổi đi qua store.dispatch bằng message cùng dạng server gửi; timer được dọn khi rời view.
 */
export function useDemoDirector(): void {
  const ctx = useContext(BridgeContext);
  const store = ctx?.store;
  const demo = ctx?.demo ?? false;

  useEffect(() => {
    if (!demo || !store) return;
    const scenario = parseScenario(typeof location !== "undefined" ? location.search : "");

    if (!applied.has(store)) {
      applied.add(store);
      for (const action of scenarioActions(scenario, store.getState(), Date.now())) store.dispatch(action);
    }

    if (scenario === "fx") {
      const id = setTimeout(() => {
        for (const action of fxBurst(store.getState(), Date.now())) store.dispatch(action);
      }, DEMO_FX_DELAY_MS);
      return () => clearTimeout(id);
    }

    if (scenario !== "live") return;
    const id = setInterval(() => {
      const tick = ticks.get(store) ?? 0;
      ticks.set(store, tick + 1);
      for (const action of directorStep(store.getState(), tick, Date.now())) store.dispatch(action);
    }, DEMO_TICK_MS);
    return () => clearInterval(id);
  }, [demo, store]);
}
