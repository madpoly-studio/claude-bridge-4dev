import { memo } from "react";
import { cx } from "../../../lib/cx";
import type { FurnitureItem } from "../model/layout";
import type { Point } from "../model/geometry";
import type { RackGauge } from "../model/system";
import { Furniture } from "./Furniture";
import styles from "./scene.module.css";

interface ServerRackGaugeProps {
  item: FurnitureItem;
  gauge: RackGauge;
}

/** Tủ server là đồng hồ tải: mỗi đèn là một slot chạy đồng thời, đèn sáng = task đang chạy. */
export const ServerRackGauge = memo(function ServerRackGauge({ item, gauge }: ServerRackGaugeProps) {
  return (
    <Furniture item={item}>
      {gauge.total > 0 && (
        <span className={styles.leds} role="img" aria-label={gauge.label}>
          {Array.from({ length: gauge.total }, (_, i) => (
            <span key={i} className={cx(styles.led, i < gauge.lit && styles.ledOn)} />
          ))}
        </span>
      )}
    </Furniture>
  );
});

/** Thẻ chữ của đồng hồ tải, vẽ ở lớp nhãn. */
export const RackLabel = memo(function RackLabel({ gauge, at }: { gauge: RackGauge; at: Point }) {
  return (
    <span className={styles.rackLabel} style={{ left: at.x, top: at.y }} aria-hidden="true">
      {gauge.label}
    </span>
  );
});
