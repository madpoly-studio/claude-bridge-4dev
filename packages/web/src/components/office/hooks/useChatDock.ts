import { useCallback, useMemo, useRef, useState } from "react";
import { readStorage, writeStorage } from "../../../lib/storage";
import { CHAT_DEFAULT_OPEN_MIN_WIDTH, CHAT_QUERY_PARAM, OFFICE_STORAGE_KEYS } from "../constants";

export type ChatTab = "planner" | "orchestrator";

export interface ChatDockState {
  open: boolean;
  tab: ChatTab;
}

export interface ChatDock extends ChatDockState {
  show(tab: ChatTab, opener?: HTMLElement | null): void;
  collapse(): void;
  /** Phần tử ngoài khung đã mở nó (nút dock, robot), để trả focus khi thu gọn. */
  opener: { current: HTMLElement | null };
  /** Tăng mỗi lần khung được mở từ bên ngoài (show có opener): lúc đó ô nhập mới nhận focus. Đổi tab trong tablist không tăng. */
  focusRequest: number;
}

const isTab = (v: string | undefined | null): v is ChatTab => v === "planner" || v === "orchestrator";

/**
 * Thuần. Thứ tự ưu tiên: `?chat=` (closed | planner | orchestrator) → giá trị đã nhớ "<tab>:<open|closed>" →
 * mặc định tab Planner, mở nếu cửa sổ đủ rộng để khung không che cảnh.
 */
export function resolveChatDock(search: string, stored: string | null, viewportWidth: number): ChatDockState {
  const [storedTab, storedOpen] = (stored ?? "").split(":");
  const base: ChatDockState = isTab(storedTab)
    ? { tab: storedTab, open: storedOpen === "open" }
    : { tab: "planner", open: viewportWidth >= CHAT_DEFAULT_OPEN_MIN_WIDTH };
  const fromUrl = new URLSearchParams(search).get(CHAT_QUERY_PARAM);
  if (fromUrl === "closed") return { ...base, open: false };
  if (isTab(fromUrl)) return { tab: fromUrl, open: true };
  return base;
}

export function useChatDock(): ChatDock {
  const [state, setState] = useState<ChatDockState>(() =>
    resolveChatDock(
      typeof location !== "undefined" ? location.search : "",
      readStorage(OFFICE_STORAGE_KEYS.chatDock),
      typeof window !== "undefined" ? window.innerWidth : 0,
    ),
  );
  const [focusRequest, setFocusRequest] = useState(0);
  const opener = useRef<HTMLElement | null>(null);
  const tabRef = useRef(state.tab);
  tabRef.current = state.tab;

  const show = useCallback((tab: ChatTab, from?: HTMLElement | null) => {
    if (from) {
      opener.current = from;
      setFocusRequest((n) => n + 1);
    }
    setState({ open: true, tab });
    writeStorage(OFFICE_STORAGE_KEYS.chatDock, `${tab}:open`);
  }, []);

  const collapse = useCallback(() => {
    writeStorage(OFFICE_STORAGE_KEYS.chatDock, `${tabRef.current}:closed`);
    setState((s) => (s.open ? { ...s, open: false } : s));
  }, []);

  return useMemo(() => ({ ...state, show, collapse, opener, focusRequest }), [state, show, collapse, focusRequest]);
}
