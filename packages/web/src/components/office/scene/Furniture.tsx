import { memo } from "react";
import type { ReactNode } from "react";
import { cx } from "../../../lib/cx";
import { FURNITURE_URLS } from "../assets";
import type { FurnitureItem } from "../model/layout";
import styles from "./scene.module.css";

interface FurnitureProps {
  item: FurnitureItem;
  /** Lớp phủ đặt theo góc trên-trái của ảnh (màn hình bàn, đèn tủ server). */
  children?: ReactNode;
}

/** Ảnh tĩnh, neo ở giữa cạnh đáy; chiều sâu theo anchor.y + depthBias. */
export const Furniture = memo(function Furniture({ item, children }: FurnitureProps) {
  return (
    <div
      className={cx(styles.item, item.flip && styles.itemFlip, item.softBase && styles.itemSoftBase)}
      style={{ left: item.anchor.x, top: item.anchor.y, zIndex: Math.round(item.anchor.y + (item.depthBias ?? 0)) }}
    >
      <img src={FURNITURE_URLS[item.sprite]} alt="" draggable={false} />
      {children}
    </div>
  );
});
