import { memo, useRef } from "react";
import type { CSSProperties, TransitionEvent } from "react";
import { createPortal } from "react-dom";
import { AGENT_URLS } from "../assets";
import { useRouteWalker } from "../hooks/useRouteWalker";
import { useSettledSpot } from "../hooks/useSettledSpot";
import { useWalkDepth } from "../hooks/useWalkDepth";
import type { AgentPlacement } from "../model/layout";
import type { SceneAgent } from "../model/scene-state";
import { ORCHESTRATOR_SHEET, PLANNER_SHEET } from "../model/sprites";
import { RobotTag } from "./RobotTag";
import type { TagTone } from "./RobotTag";
import { Sprite } from "./Sprite";
import styles from "./scene.module.css";

interface AgentRobotProps {
  agent: SceneAgent;
  /** Góc đứng mặc định và chỗ làm việc của agent này. */
  placement: AgentPlacement;
  labelLayer: HTMLElement | null;
  reducedMotion: boolean;
  onActivate(agent: SceneAgent, opener: HTMLElement): void;
}

const NAME = { planner: "Planner", orchestrator: "Orchestrator" } as const;
const SHEET = { planner: PLANNER_SHEET, orchestrator: ORCHESTRATOR_SHEET } as const;

/** Thẻ tên khi agent đang đi: ngay dưới chân, không lấy độ lệch của chỗ đứng đích (thẻ không nhảy ngang lúc khởi hành). */
const AGENT_WALKING_TAG = { x: 0, y: 6 };

const TONE: Record<SceneAgent["anim"], TagTone> = { idle: "idle", processing: "busy", alert: "alert", off: "offline" };

/**
 * Robot planner / orchestrator: lơ lửng trên một điểm của sàn, bấm để mở khung chat đúng tab.
 * Rảnh thì đứng ở góc home; có việc thì tự đi lên chỗ work bằng cùng bộ máy đi của worker (useRouteWalker).
 * Thẻ tên được portal vào lớp nhãn (không bị nội thất che) và đi theo robot.
 */
export const AgentRobot = memo(function AgentRobot({ agent, placement, labelLayer, reducedMotion, onActivate }: AgentRobotProps) {
  const sheet = SHEET[agent.role];
  const stand = placement[useSettledSpot(agent.spot)];
  const walk = useRouteWalker(stand.anchor.x, stand.anchor.y, stand.gate.x, stand.gate.y, stand.facing, reducedMotion);
  const actorRef = useRef<HTMLDivElement>(null);
  const tagRef = useRef<HTMLDivElement>(null);
  useWalkDepth(walk, actorRef, tagRef, labelLayer);

  // z-index không nằm trong style của React: useWalkDepth ghi thẳng lên DOM.
  const place = { transform: `translate(${walk.x}px, ${walk.y}px)`, "--seg-ms": `${walk.segmentMs}ms` } as CSSProperties;
  const hit: CSSProperties = { left: -sheet.anchor.x, top: -sheet.anchor.y, width: sheet.display.w, height: sheet.anchor.y };

  // Chỉ dùng độ lệch thẻ của chỗ đứng khi robot đã đứng đúng chỗ đó (stand đổi trước khi walker kịp khởi hành một nhịp).
  const atStand = !walk.moving && walk.x === stand.anchor.x && walk.y === stand.anchor.y;
  const tag = atStand ? stand.tag : AGENT_WALKING_TAG;

  const onTransitionEnd = (e: TransitionEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget && e.propertyName === "transform") walk.onSegmentEnd();
  };

  return (
    <>
      <div
        ref={actorRef}
        className={styles.actor}
        style={place}
        data-ready={walk.ready}
        data-moving={walk.moving}
        data-agent={agent.role}
        onTransitionEnd={onTransitionEnd}
      >
        <span className={styles.agentShadow} data-anim={agent.anim} aria-hidden="true" />
        {agent.anim === "processing" && !walk.moving && (
          <span className={styles.ringBox} aria-hidden="true">
            <span className={styles.ring} />
          </span>
        )}
        <button type="button" className={styles.hit} style={hit} aria-label={agent.ariaLabel} onClick={(e) => onActivate(agent, e.currentTarget)}>
          <span className={styles.agentFloat} data-anim={agent.anim} data-moving={walk.moving}>
            <Sprite sheet={sheet} url={AGENT_URLS[agent.role]} anim="idle" flip={walk.facing === -1} />
            {agent.anim === "alert" && (
              <span className={styles.alertMark} aria-hidden="true">
                !
              </span>
            )}
          </span>
        </button>
      </div>
      {labelLayer &&
        createPortal(
          <div ref={tagRef} className={styles.tagAnchor} style={place} data-ready={walk.ready}>
            <RobotTag name={NAME[agent.role]} stateLabel={agent.statusLabel} tone={TONE[agent.anim]} offsetX={tag.x} offsetY={tag.y} stacked />
          </div>,
          labelLayer,
        )}
    </>
  );
});
