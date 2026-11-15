import type { CSSProperties } from "react";
import { FX_MS } from "../constants";
import type { BubbleTone } from "../model/effects";
import styles from "./scene.module.css";

interface SpeechBubbleProps {
  /** Đổi id thì bong bóng hiện lại từ đầu. */
  id: number;
  text: string;
  tone: BubbleTone;
  /** Khoảng cách từ điểm neo của robot lên đỉnh đầu (hệ cảnh). */
  lift: number;
}

const DURATION_MS: Record<BubbleTone, number> = {
  progress: FX_MS.bubble,
  fail: FX_MS.error,
  info: FX_MS.cancelBubble,
};

const MAX_CHARS = 48;

/** Bong bóng thoại trên đầu robot; tự mờ khi gần hết hạn (hết hạn thật do useOfficeFx gỡ). */
export function SpeechBubble({ id, text, tone, lift }: SpeechBubbleProps) {
  const shown = text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS - 1)}…` : text;
  const style = { "--bubble-ms": `${DURATION_MS[tone]}ms`, "--lift": `${lift}px` } as CSSProperties;
  return (
    <div key={id} className={styles.bubble} data-tone={tone} style={style} role="status">
      {shown}
    </div>
  );
}
