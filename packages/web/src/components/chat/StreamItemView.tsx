import { memo } from "react";
import { cx } from "../../lib/cx";
import { formatToolChip, wakeWarningText } from "../../state/stream";
import type { StreamItem } from "../../state/stream";
import { Icon } from "../common/Icon";
import { MessageText } from "./MessageText";
import { SystemTurnsLine } from "./SystemTurnsLine";
import { ToolGroupLine } from "./ToolGroupLine";
import styles from "./chat.module.css";

interface StreamItemViewProps {
  item: StreamItem;
  /** Tên hiện phía trên khối trả lời của agent ("planner", "orchestrator"). */
  speaker: string;
  showSpeaker: boolean;
}

export const StreamItemView = memo(function StreamItemView({ item, speaker, showSpeaker }: StreamItemViewProps) {
  switch (item.kind) {
    case "user":
      return (
        <div className={styles.userBubble}>
          <span className="visually-hidden">Bạn: </span>
          {item.text}
        </div>
      );
    case "agent":
      return (
        <div className={styles.agentBlock}>
          {showSpeaker && <span className={styles.speaker}>{speaker}</span>}
          <MessageText text={item.text} />
        </div>
      );
    case "tool": {
      const failed = item.call.result?.isError === true;
      return (
        <div className={styles.agentBlock}>
          {showSpeaker && <span className={styles.speaker}>{speaker}</span>}
          <span className={cx(styles.toolChip, failed && styles.toolChipError)} title={item.call.name}>
            {formatToolChip(item.call)}
            {failed && " · lỗi"}
          </span>
        </div>
      );
    }
    case "tool-group":
      return <ToolGroupLine calls={item.calls} />;
    case "system-turns":
      return <SystemTurnsLine turns={item.turns} />;
    case "wake-warning":
      return (
        <div className={styles.warning} role="note">
          <Icon name="warning" size={16} className={styles.warningIcon} />
          <span className={styles.warningType}>{item.event.type}</span>
          <span>{wakeWarningText(item.event)}</span>
        </div>
      );
    case "notice":
      return <div className={cx(styles.notice, item.tone === "warn" && styles.noticeWarn)}>{item.text}</div>;
    case "welcome":
      return (
        <div className={styles.welcome} role="note" aria-label="Thông báo của bridge">
          <span className={styles.welcomeTitle}>bridge</span>
          <MessageText text={item.text} />
        </div>
      );
    case "raw":
      return <div className={styles.raw}>{item.text}</div>;
    default:
      return null;
  }
});
