import { memo, useRef } from "react";
import type { CSSProperties, TransitionEvent } from "react";
import { createPortal } from "react-dom";
import { WORKER_SHEET_URLS } from "../assets";
import { useRouteWalker } from "../hooks/useRouteWalker";
import { useWalkDepth } from "../hooks/useWalkDepth";
import { SCENE_LABEL, sceneWorkerEqual } from "../model/scene-state";
import type { SceneWorker } from "../model/scene-state";
import { WORKER_BODY, WORKER_SHEET } from "../model/sprites";
import { RobotTag } from "./RobotTag";
import type { TagTone } from "./RobotTag";
import { SpeechBubble } from "./SpeechBubble";
import { Sprite } from "./Sprite";
import styles from "./scene.module.css";

interface WorkerRobotProps {
  actor: SceneWorker;
  labelLayer: HTMLElement | null;
  reducedMotion: boolean;
  onActivate(actor: SceneWorker, opener: HTMLElement): void;
}

/** happy lặp 3 lượt (1,8 s) để kịp nhận ra; hết hiệu ứng do timer của useOfficeFx quyết định. */
const HAPPY_ITERATIONS = 3;
/** Thẻ tên khi robot đang đi: ngay dưới chân. */
const WALKING_TAG = { x: 0, y: 5 };

function toneOf(actor: SceneWorker): TagTone {
  if (actor.anim === "happy") return "done";
  if (actor.anim === "error") return "fail";
  if (actor.anim === "sleep") return "offline";
  if (actor.stateLabel === SCENE_LABEL.waitingRunner) return "wait";
  return actor.zone === "relax" ? "idle" : "busy";
}

const HIT_STYLE: CSSProperties = { left: -WORKER_BODY.w / 2, top: -WORKER_BODY.h, width: WORKER_BODY.w, height: WORKER_BODY.h };
const SPRITE_BOX_STYLE: CSSProperties = { left: WORKER_BODY.w / 2 - WORKER_SHEET.anchor.x, top: WORKER_BODY.h - WORKER_SHEET.anchor.y };

/** Một robot worker: nút bấm có aria-label, sprite theo trạng thái, tự trượt qua các waypoint khi đổi chỗ. */
export const WorkerRobot = memo(
  function WorkerRobot({ actor, labelLayer, reducedMotion, onActivate }: WorkerRobotProps) {
    const walk = useRouteWalker(actor.x, actor.y, actor.gateX, actor.gateY, actor.facing, reducedMotion);
    const anim = walk.moving ? "move" : actor.anim;
    const actorRef = useRef<HTMLDivElement>(null);
    const tagRef = useRef<HTMLDivElement>(null);

    useWalkDepth(walk, actorRef, tagRef, labelLayer);

    // z-index không nằm trong style của React: useWalkDepth ghi thẳng lên DOM.
    const place = { transform: `translate(${walk.x}px, ${walk.y}px)`, "--seg-ms": `${walk.segmentMs}ms` } as CSSProperties;

    const onTransitionEnd = (e: TransitionEvent<HTMLDivElement>) => {
      // Sự kiện của phần tử con (kể cả qua portal) cũng nổi lên đây.
      if (e.target === e.currentTarget && e.propertyName === "transform") walk.onSegmentEnd();
    };

    const tag = walk.moving ? WALKING_TAG : { x: actor.tagX, y: actor.tagY };

    return (
      <>
        <div ref={actorRef} className={styles.actor} style={place} data-ready={walk.ready} data-moving={walk.moving} onTransitionEnd={onTransitionEnd}>
          <span className={styles.shadow} aria-hidden="true" />
          <button type="button" className={styles.hit} style={HIT_STYLE} aria-label={actor.ariaLabel} onClick={(e) => onActivate(actor, e.currentTarget)}>
            <span className={styles.spriteBox} style={SPRITE_BOX_STYLE}>
              <Sprite
                sheet={WORKER_SHEET}
                url={WORKER_SHEET_URLS[actor.skin]}
                anim={anim}
                replayKey={actor.animKey}
                iterations={anim === "happy" ? HAPPY_ITERATIONS : undefined}
                flip={walk.facing === -1}
              />
            </span>
          </button>
        </div>
        {labelLayer &&
          createPortal(
            <div ref={tagRef} className={styles.tagAnchor} style={place} data-ready={walk.ready}>
              <RobotTag
                name={actor.id}
                stateLabel={actor.stateLabel}
                tone={toneOf(actor)}
                detail={actor.detail}
                phaseIndex={actor.phaseIndex}
                offsetX={tag.x}
                offsetY={tag.y}
              />
              {actor.bubbleText && <SpeechBubble id={actor.bubbleId} text={actor.bubbleText} tone={actor.bubbleTone} lift={WORKER_BODY.h} />}
            </div>,
            labelLayer,
          )}
      </>
    );
  },
  (prev, next) =>
    prev.labelLayer === next.labelLayer &&
    prev.reducedMotion === next.reducedMotion &&
    prev.onActivate === next.onActivate &&
    sceneWorkerEqual(prev.actor, next.actor),
);
