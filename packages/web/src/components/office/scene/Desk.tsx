import { memo } from "react";
import type { CSSProperties } from "react";
import { DESK_SCREENS } from "../model/layout";
import type { DeskItem } from "../model/layout";
import type { DeskScreen } from "../model/scene-state";
import { Furniture } from "./Furniture";
import styles from "./scene.module.css";

interface DeskProps {
  item: DeskItem;
  screen: DeskScreen;
}

/** Bàn làm việc + màn hình đổi theo phase của task. Màn hình chỉ là trang trí: phase đã có ở thẻ tên và aria-label của robot. */
export const Desk = memo(function Desk({ item, screen }: DeskProps) {
  const rect = DESK_SCREENS[item.sprite];
  const style = { left: rect.x, top: rect.y, width: rect.w, height: rect.h, "--skew": `${rect.skewDeg}deg` } as CSSProperties;
  return (
    <Furniture item={item}>
      {screen !== "off" && (
        <span className={styles.screen} data-screen={screen} style={style} aria-hidden="true">
          <span className={styles.screenContent} />
        </span>
      )}
    </Furniture>
  );
});
