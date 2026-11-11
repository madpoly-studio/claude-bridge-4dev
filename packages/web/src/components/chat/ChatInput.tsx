import { useId, useState } from "react";
import type { KeyboardEvent } from "react";
import { cx } from "../../lib/cx";
import ui from "../common/ui.module.css";
import styles from "./chat.module.css";

interface ChatInputProps {
  label: string;
  placeholder: string;
  disabled?: boolean;
  disabledReason?: string;
  busy?: boolean;
  onSend: (text: string) => Promise<boolean>;
  onInterrupt: () => Promise<boolean>;
}

/** Ô nhập chat: Enter gửi, Shift+Enter xuống dòng; Ngắt dừng turn đang chạy. */
export function ChatInput({ label, placeholder, disabled = false, disabledReason, busy = false, onSend, onInterrupt }: ChatInputProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);

  const canSend = !disabled && !sending && text.trim() !== "";

  const send = async () => {
    if (!canSend) return;
    setSending(true);
    const ok = await onSend(text.trim());
    setSending(false);
    if (ok) setText("");
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  };

  return (
    <>
      <label htmlFor={id} className={ui.fieldLabel}>
        {label}
      </label>
      <div className={styles.inputRow}>
        <textarea
          id={id}
          rows={2}
          className={styles.textarea}
          placeholder={placeholder}
          value={text}
          disabled={disabled}
          aria-describedby={hintId}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className={styles.inputButtons}>
          <button type="button" className={cx(ui.btn, ui.primary)} disabled={!canSend} onClick={() => void send()}>
            {sending ? "Đang gửi…" : "Gửi"}
          </button>
          <button
            type="button"
            className={cx(ui.btn, ui.ghost)}
            disabled={disabled}
            title={busy ? "Ngắt turn đang chạy" : "Không có turn đang chạy"}
            onClick={() => void onInterrupt()}
          >
            Ngắt
          </button>
        </div>
      </div>
      <span id={hintId} className={styles.hint}>
        {disabled && disabledReason ? disabledReason : "Enter để gửi, Shift+Enter xuống dòng"}
      </span>
    </>
  );
}
