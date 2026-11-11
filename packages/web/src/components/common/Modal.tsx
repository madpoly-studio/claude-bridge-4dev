import { useEffect, useRef } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { cx } from "../../lib/cx";
import styles from "./modal.module.css";

interface ModalProps {
  labelledBy: string;
  onClose: () => void;
  children: ReactNode;
  /** dialog: hộp giữa màn hình; drawer: panel trượt bên phải. */
  variant?: "dialog" | "drawer";
}

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Hộp thoại modal: Escape để đóng, giữ focus bên trong, trả focus khi đóng. */
export function Modal({ labelledBy, onClose, children, variant = "dialog" }: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    const first = panel?.querySelector<HTMLElement>("[data-autofocus]") ?? panel?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? panel)?.focus();
    return () => previous?.focus?.();
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== "Tab" || !panelRef.current) return;
    const items = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (items.length === 0) return;
    const first = items[0]!;
    const last = items[items.length - 1]!;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <div className={cx(styles.backdrop, variant === "drawer" && styles.backdropDrawer)} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        className={cx(styles.panel, variant === "drawer" ? styles.drawer : styles.dialog)}
        onKeyDown={onKeyDown}
      >
        {children}
      </div>
    </div>
  );
}
