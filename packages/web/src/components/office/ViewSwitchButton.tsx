import { cx } from "../../lib/cx";
import ui from "../common/ui.module.css";
import type { ViewMode } from "./view-mode";

interface ViewSwitchButtonProps {
  mode: ViewMode;
  onChange: (mode: ViewMode) => void;
}

/** Nút trên top bar: chuyển giữa Dashboard 3 cột và Văn phòng. Nhãn là nơi sẽ chuyển tới. */
export function ViewSwitchButton({ mode, onChange }: ViewSwitchButtonProps) {
  const toOffice = mode === "dashboard";
  return (
    <button
      type="button"
      className={cx(ui.btn, ui.accentGhost)}
      aria-label={toOffice ? "Chuyển sang chế độ Văn phòng" : "Chuyển sang Dashboard"}
      onClick={() => onChange(toOffice ? "office" : "dashboard")}
    >
      {toOffice ? "Văn phòng" : "Dashboard"}
    </button>
  );
}
