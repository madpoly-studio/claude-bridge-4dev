import { useEffect, useId, useRef } from "react";
import type { KeyboardEvent } from "react";
import { cx } from "../../../lib/cx";
import { Icon } from "../../common/Icon";
import ui from "../../common/ui.module.css";
import { OrchestratorColumn } from "../../orchestrator/OrchestratorColumn";
import { PlannerColumn } from "../../planner/PlannerColumn";
import { AGENT_URLS } from "../assets";
import type { ChatDock, ChatTab } from "../hooks/useChatDock";
import type { SceneAgent } from "../model/scene-state";
import styles from "./floating-chat.module.css";

interface FloatingChatProps {
  dock: ChatDock;
  planner: SceneAgent;
  orchestrator: SceneAgent;
}

const TABS: Array<{ id: ChatTab; label: string }> = [
  { id: "planner", label: "Planner" },
  { id: "orchestrator", label: "Orchestrator" },
];

/** Huy hiệu có chữ: "!" + số bản nháp chờ duyệt, hoặc chấm "đang bận". */
function Badge({ agent }: { agent: SceneAgent }) {
  if (agent.pendingCount > 0) {
    return (
      <span className={cx(styles.badge, styles.badgeAlert)}>
        <span aria-hidden="true">!</span>
        <span className="visually-hidden">{agent.pendingCount} bản nháp chờ duyệt</span>
      </span>
    );
  }
  if (agent.anim === "processing") {
    return (
      <span className={cx(styles.badge, styles.badgeBusy)}>
        <span className="visually-hidden">đang bận</span>
      </span>
    );
  }
  if (agent.anim === "alert") {
    return (
      <span className={cx(styles.badge, styles.badgeAlert)}>
        <span aria-hidden="true">!</span>
        <span className="visually-hidden">{agent.statusLabel}</span>
      </span>
    );
  }
  return null;
}

function dockLabel(label: string, agent: SceneAgent): string {
  if (agent.pendingCount > 0) return `Mở chat ${label}, ${agent.pendingCount} bản nháp chờ duyệt`;
  if (agent.anim === "processing") return `Mở chat ${label}, đang bận`;
  return `Mở chat ${label}, ${agent.statusLabel}`;
}

/**
 * Khung chat nổi: khi mở chiếm gần trọn phần bên phải của vùng cảnh (cách bản đồ và các mép một khe nhỏ), thu gọn thì còn
 * hai avatar ở góc dưới phải. 2 tab bọc nguyên PlannerColumn / OrchestratorColumn (không prop, không sửa file cũ),
 * nên gate Duyệt / Sửa / Hủy, chọn phiên, Phiên mới, Gửi, Ngắt hoạt động y như dashboard.
 * Cả hai pane luôn mount (ẩn bằng visibility) để nháp đang gõ không mất và khung cuộn vẫn bám đáy.
 * Không phải modal: không bẫy focus; Escape thu gọn và trả focus về nơi đã mở (hoặc nút dock của tab đang chọn).
 */
export function FloatingChat({ dock, planner, orchestrator }: FloatingChatProps) {
  const baseId = useId();
  const frameRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef<Record<ChatTab, HTMLButtonElement | null>>({ planner: null, orchestrator: null });
  const dockRefs = useRef<Record<ChatTab, HTMLButtonElement | null>>({ planner: null, orchestrator: null });
  const agents: Record<ChatTab, SceneAgent> = { planner, orchestrator };
  const { open, tab, focusRequest } = dock;

  // Chỉ khi khung được mở từ bên ngoài (nút dock, robot): focus ô nhập của pane, không được thì focus tab.
  // Đổi tab ngay trong tablist (bấm, phím mũi tên) không qua đây, nên focus ở lại trên tab.
  // So với giá trị lần trước nên lần mount đầu (kể cả StrictMode chạy lại effect) không cướp focus.
  const lastFocusRequest = useRef(focusRequest);
  useEffect(() => {
    if (lastFocusRequest.current === focusRequest) return;
    lastFocusRequest.current = focusRequest;
    if (!open) return;
    const pane = frameRef.current?.querySelector<HTMLElement>(`[data-pane="${tab}"]`);
    const input = pane?.querySelector<HTMLTextAreaElement>("textarea:not([disabled])");
    (input ?? tabRefs.current[tab])?.focus();
  }, [focusRequest, open, tab]);

  // Thu gọn: trả focus về nơi đã mở nếu nó còn trong trang (robot), không thì về nút dock của tab đang chọn.
  // Nút dock chỉ mount sau khi khung đóng (và nút dock đã mở khung thì đã bị gỡ), nên phải làm sau commit.
  const restoreFocus = useRef(false);
  useEffect(() => {
    if (open || !restoreFocus.current) return;
    restoreFocus.current = false;
    const opener = dock.opener.current;
    (opener?.isConnected ? opener : dockRefs.current[tab])?.focus();
  }, [open, tab, dock.opener]);

  const collapse = () => {
    restoreFocus.current = true;
    dock.collapse();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // Modal bên trong (NewSessionDialog) đã stopPropagation cho Escape của nó.
    if (e.key === "Escape") collapse();
  };

  const onTabKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const next: ChatTab = tab === "planner" ? "orchestrator" : "planner";
    dock.show(next);
    tabRefs.current[next]?.focus();
  };

  return (
    <aside className={styles.root} data-open={open} aria-label="Chat với agent">
      <div ref={frameRef} className={styles.frame} data-open={open} onKeyDown={onKeyDown}>
        <div className={styles.head}>
          <div className={styles.tabs} role="tablist" aria-label="Agent" onKeyDown={onTabKeyDown}>
            {TABS.map((t) => (
              <button
                key={t.id}
                ref={(el) => {
                  tabRefs.current[t.id] = el;
                }}
                type="button"
                role="tab"
                id={`${baseId}-tab-${t.id}`}
                aria-selected={tab === t.id}
                aria-controls={`${baseId}-pane-${t.id}`}
                tabIndex={tab === t.id ? 0 : -1}
                className={cx(styles.tab, tab === t.id && styles.tabActive)}
                onClick={() => dock.show(t.id)}
              >
                <span className={styles.tabAvatar}>
                  <img src={AGENT_URLS[t.id]} alt="" draggable={false} />
                </span>
                {t.label}
                <Badge agent={agents[t.id]} />
              </button>
            ))}
          </div>
          <button type="button" className={cx(ui.btn, ui.ghost, ui.iconBtn, styles.collapse)} aria-label="Thu gọn khung chat" title="Thu gọn" onClick={collapse}>
            <Icon name="chevronDown" size={16} />
          </button>
        </div>
        <div className={styles.panes}>
          {TABS.map((t) => (
            <div
              key={t.id}
              id={`${baseId}-pane-${t.id}`}
              role="tabpanel"
              aria-labelledby={`${baseId}-tab-${t.id}`}
              className={styles.pane}
              data-pane={t.id}
              data-active={tab === t.id}
            >
              {t.id === "planner" ? <PlannerColumn /> : <OrchestratorColumn />}
            </div>
          ))}
        </div>
      </div>

      {!open && (
        <div className={styles.dock}>
          {TABS.map((t) => (
            <button
              key={t.id}
              ref={(el) => {
                dockRefs.current[t.id] = el;
              }}
              type="button"
              className={styles.dockBtn}
              aria-label={dockLabel(t.label, agents[t.id])}
              title={t.label}
              onClick={(e) => dock.show(t.id, e.currentTarget)}
            >
              <img src={AGENT_URLS[t.id]} alt="" draggable={false} />
              <Badge agent={agents[t.id]} />
              <span className={styles.dockName} aria-hidden="true">
                {t.label}
              </span>
            </button>
          ))}
        </div>
      )}
    </aside>
  );
}
