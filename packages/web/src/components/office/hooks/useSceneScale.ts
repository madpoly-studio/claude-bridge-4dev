import { useLayoutEffect, useRef } from "react";
import type { RefObject } from "react";
import {
  CHAT_GAP_PX,
  CHAT_MAX_WIDTH_PX,
  CHAT_MIN_WIDTH_PX,
  CHAT_SHEET_BELOW_PX,
  LABEL_SCALE_EXPONENT,
  LABEL_SCALE_MAX,
  LABEL_SCALE_MIN,
  MIN_SCENE_SCALE,
  SCENE_FIT_TRANSITION_MS,
} from "../constants";
import { SCENE_H, SCENE_W } from "../model/geometry";

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** side: khung chat đứng cạnh bản đồ, bên phải; sheet: vùng cảnh hẹp, khung chat là bottom sheet đè lên bản đồ. */
export type ChatLayout = "side" | "sheet";

export interface SceneFit {
  scale: number;
  labelScale: number;
  /** Lề trái của bản đồ trong vùng cảnh. */
  left: number;
  chatLayout: ChatLayout;
  /** Bề rộng khung chat khi đứng cạnh bản đồ; 0 khi thu gọn hoặc ở dạng bottom sheet. */
  chatWidth: number;
}

/**
 * Thuần: kích thước vùng cảnh (dưới top bar và banner) → scale và lề trái của bản đồ, scale ngược của nhãn, bề rộng khung chat.
 *
 * Khung chat thu gọn (hoặc vùng cảnh hẹp, chat là bottom sheet): bản đồ lấy cả vùng, canh giữa.
 * Khung chat mở, từ trái sang phải: [phần dư] bản đồ | khe | khung chat | khe. Bản đồ co cho vừa phần còn lại sau khi
 * khung chat lấy bề rộng tối thiểu; bản đồ bị chiều cao giới hạn thì khung chat nở ra (tới tối đa) để lấp chỗ trống,
 * còn dư nữa mới dồn sang bên trái bản đồ. Không bao giờ có khoảng trống giữa bản đồ và khung chat.
 * Cửa sổ quá hẹp: sàn MIN_SCENE_SCALE thắng, mép phải bản đồ nằm dưới khung chat.
 */
export function computeSceneFit(width: number, height: number, chatOpen: boolean): SceneFit {
  const chatLayout: ChatLayout = width < CHAT_SHEET_BELOW_PX ? "sheet" : "side";
  const beside = chatOpen && chatLayout === "side";
  // Bề rộng cho bản đồ + khung chat sau khi trừ hai khe (trái và phải khung chat).
  const room = beside ? width - 2 * CHAT_GAP_PX : width;
  const mapRoom = beside ? room - CHAT_MIN_WIDTH_PX : room;
  const scale = Math.max(MIN_SCENE_SCALE, Math.min(mapRoom / SCENE_W, height / SCENE_H));
  const labelScale = clamp(Math.pow(scale, -LABEL_SCALE_EXPONENT), LABEL_SCALE_MIN, LABEL_SCALE_MAX);
  const mapWidth = SCENE_W * scale;
  if (!beside) return { scale, labelScale, left: Math.max(0, Math.round((room - mapWidth) / 2)), chatLayout, chatWidth: 0 };
  const chatWidth = clamp(Math.floor(room - mapWidth), CHAT_MIN_WIDTH_PX, CHAT_MAX_WIDTH_PX);
  return { scale, labelScale, left: Math.max(0, Math.round(room - chatWidth - mapWidth)), chatLayout, chatWidth };
}

/**
 * Theo dõi kích thước vùng cảnh (`host`, phần tử chứa cả bản đồ lẫn khung chat) và ghi kết quả computeSceneFit thẳng lên nó:
 * biến CSS --scene-scale, --label-scale, --scene-left cho bản đồ; --chat-width, --chat-gap và data-chat-layout cho khung chat.
 * Bản đồ và khung chat đọc chung một nguồn nên không lệch nhau. Không setState, nên đổi cỡ cửa sổ không render lại cảnh.
 * Không có ResizeObserver hoặc phần tử chưa có kích thước (jsdom): giữ scale 1, CSS dùng giá trị mặc định.
 * Khi `chatOpen` đổi, bản đồ trượt về vị trí mới trong SCENE_FIT_TRANSITION_MS qua biến --scene-fit-ms;
 * đổi cỡ cửa sổ thì áp ngay để không trễ theo tay kéo.
 */
export function useSceneScale(host: RefObject<HTMLElement>, chatOpen: boolean): void {
  const lastOpen = useRef(chatOpen);
  useLayoutEffect(() => {
    const el = host.current;
    if (!el) return;
    let fitTimer: ReturnType<typeof setTimeout> | null = null;
    const endFitTransition = () => {
      if (fitTimer !== null) clearTimeout(fitTimer);
      fitTimer = null;
      el.style.removeProperty("--scene-fit-ms");
    };
    if (lastOpen.current !== chatOpen) {
      lastOpen.current = chatOpen;
      if (el.clientWidth > 0) {
        el.style.setProperty("--scene-fit-ms", `${SCENE_FIT_TRANSITION_MS}ms`);
        fitTimer = setTimeout(endFitTransition, SCENE_FIT_TRANSITION_MS);
      }
    }
    const apply = () => {
      const { clientWidth, clientHeight } = el;
      if (clientWidth === 0 || clientHeight === 0) return;
      const fit = computeSceneFit(clientWidth, clientHeight, chatOpen);
      el.style.setProperty("--scene-scale", String(fit.scale));
      el.style.setProperty("--label-scale", String(fit.labelScale));
      el.style.setProperty("--scene-left", `${fit.left}px`);
      el.style.setProperty("--chat-gap", `${CHAT_GAP_PX}px`);
      if (fit.chatWidth > 0) el.style.setProperty("--chat-width", `${fit.chatWidth}px`);
      else el.style.removeProperty("--chat-width");
      el.dataset.chatLayout = fit.chatLayout;
    };
    apply();
    if (typeof ResizeObserver === "undefined") return endFitTransition;
    const observer = new ResizeObserver(apply);
    observer.observe(el);
    return () => {
      observer.disconnect();
      endFitTransition();
    };
  }, [host, chatOpen]);
}
