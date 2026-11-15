import { SCENE_H, SCENE_W } from "../model/geometry";
import type { OfficeLayout } from "../model/layout";
import styles from "./scene.module.css";

const STEP = 100;

/** `?debug=grid`: lưới 100 px, điểm neo của slot, chỗ đứng của agent và nội thất, gate. Chỉ dùng khi chỉnh layout.ts. */
export function DebugGrid({ layout }: { layout: OfficeLayout }) {
  const agentStands = (["planner", "orchestrator"] as const).flatMap((role) =>
    (["home", "work"] as const).map((spot) => ({ id: `${role}-${spot}`, ...layout[role][spot] })),
  );
  const slots = [...layout.desks, ...layout.relax, ...layout.pods, ...agentStands];
  const items = [...layout.furniture, ...layout.deskItems, ...layout.serverRacks, layout.kanban.item];
  const xs = Array.from({ length: Math.floor(SCENE_W / STEP) }, (_, i) => (i + 1) * STEP);
  const ys = Array.from({ length: Math.floor(SCENE_H / STEP) }, (_, i) => (i + 1) * STEP);
  return (
    <div className={styles.debug} aria-hidden="true">
      {xs.map((x) => (
        <span key={`x${x}`} className={styles.debugLineX} style={{ left: x }}>
          {x}
        </span>
      ))}
      {ys.map((y) => (
        <span key={`y${y}`} className={styles.debugLineY} style={{ top: y }}>
          {y}
        </span>
      ))}
      {items.map((it) => (
        <span key={it.id} className={styles.debugDot} data-kind="item" style={{ left: it.anchor.x, top: it.anchor.y }} />
      ))}
      {slots.map((s) => (
        <span key={s.id}>
          <span className={styles.debugDot} data-kind="slot" style={{ left: s.anchor.x, top: s.anchor.y }}>
            {s.id}
          </span>
          <span className={styles.debugDot} data-kind="gate" style={{ left: s.gate.x, top: s.gate.y }} />
        </span>
      ))}
    </div>
  );
}
