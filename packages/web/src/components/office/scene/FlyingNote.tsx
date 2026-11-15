import { memo } from "react";
import type { CSSProperties } from "react";
import { FX_MS } from "../constants";
import type { Point } from "../model/geometry";
import styles from "./scene.module.css";

interface FlyingNoteProps {
  from: Point;
  to: Point;
}

/** Giấy note bay từ bàn lên bảng kanban khi task hoàn thành: x đi đều ở phần tử ngoài, y theo đường cong ở phần tử trong. */
export const FlyingNote = memo(function FlyingNote({ from, to }: FlyingNoteProps) {
  const style = {
    left: from.x,
    top: from.y,
    "--dx": `${to.x - from.x}px`,
    "--dy": `${to.y - from.y}px`,
    "--note-ms": `${FX_MS.note}ms`,
  } as CSSProperties;
  return (
    <span className={styles.noteX} style={style} aria-hidden="true">
      <span className={styles.noteY}>
        <span className={styles.note} />
      </span>
    </span>
  );
});
