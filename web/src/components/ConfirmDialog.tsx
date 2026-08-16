"use client";

import { useEffect, useRef } from "react";

/**
 * The design system's dialog. Used for "Clear queue", which the handoff says must confirm
 * before emptying.
 *
 * A native `<dialog>` in modal mode, so focus trapping, Escape and the inert backdrop come
 * from the platform instead of being reimplemented.
 */
export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  danger,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  body: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  if (!open) return null;

  return (
    <dialog
      ref={ref}
      className="dialog"
      style={{ border: 0, padding: "26px", maxWidth: "min(440px, 100%)" }}
      onCancel={(e) => {
        e.preventDefault();
        onCancel();
      }}
      onClick={(e) => {
        // A click that lands on the dialog element itself is a click on the backdrop —
        // the content sits in child elements.
        if (e.target === ref.current) onCancel();
      }}
    >
      <div className="dialog-title">{title}</div>
      <div className="dialog-body">{body}</div>
      <div className="dialog-actions">
        <button type="button" className="btn btn-secondary" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className={danger ? "btn btn-secondary btn-danger" : "btn btn-primary"}
          onClick={onConfirm}
          autoFocus
        >
          {confirmLabel}
        </button>
      </div>
    </dialog>
  );
}
