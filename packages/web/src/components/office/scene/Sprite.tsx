import type { CSSProperties } from "react";
import { spriteVars } from "../model/sprites";
import type { SheetSpec } from "../model/sprites";
import styles from "./scene.module.css";

interface SpriteProps<A extends string> {
  sheet: SheetSpec<A>;
  url: string;
  anim: A;
  /** Đổi giá trị thì animation phát lại từ frame 0. */
  replayKey?: number;
  iterations?: number;
  flip?: boolean;
}

/** Một ô của sprite sheet, chạy bằng steps() trên background-position. Trang trí: nhãn chữ nằm ở phần tử cha. */
export function Sprite<A extends string>({ sheet, url, anim, replayKey = 0, iterations, flip = false }: SpriteProps<A>) {
  const style = {
    ...spriteVars(sheet, anim, iterations),
    width: sheet.display.w,
    height: sheet.display.h,
    backgroundImage: `url(${url})`,
    transform: flip ? "scaleX(-1)" : undefined,
  } as CSSProperties;
  // key đổi → React mount lại phần tử → animation CSS chạy lại từ đầu.
  return <span key={`${anim}:${replayKey}`} className={styles.sprite} data-static={sheet.anims[anim].frames <= 1} style={style} aria-hidden="true" />;
}
