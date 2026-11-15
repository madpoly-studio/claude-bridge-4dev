import { useCallback, useState } from "react";
import { readStorage, writeStorage } from "../../lib/storage";
import { OFFICE_STORAGE_KEYS, VIEW_QUERY_PARAM } from "./constants";

export type ViewMode = "dashboard" | "office";

const isViewMode = (v: string | null): v is ViewMode => v === "dashboard" || v === "office";

/** `?view=` thắng lựa chọn đã nhớ cho lần tải này; không hợp lệ thì về dashboard. Thuần. */
export function resolveViewMode(search: string, stored: string | null): ViewMode {
  const fromUrl = new URLSearchParams(search).get(VIEW_QUERY_PARAM);
  if (isViewMode(fromUrl)) return fromUrl;
  return isViewMode(stored) ? stored : "dashboard";
}

/** Bấm nút thì ghi storage và gỡ `view` khỏi URL, để refresh không đè lại lựa chọn vừa bấm. */
export function useViewMode(): [ViewMode, (mode: ViewMode) => void] {
  const [mode, setMode] = useState<ViewMode>(() =>
    resolveViewMode(typeof location !== "undefined" ? location.search : "", readStorage(OFFICE_STORAGE_KEYS.viewMode)),
  );
  const change = useCallback((next: ViewMode) => {
    setMode(next);
    writeStorage(OFFICE_STORAGE_KEYS.viewMode, next);
    if (typeof location === "undefined" || typeof history === "undefined") return;
    const url = new URL(location.href);
    if (!url.searchParams.has(VIEW_QUERY_PARAM)) return;
    url.searchParams.delete(VIEW_QUERY_PARAM);
    history.replaceState(history.state, "", url);
  }, []);
  return [mode, change];
}
