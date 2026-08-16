"use client";

import Link from "next/link";

import { useEffect, useRef } from "react";

/**
 * What "Open avatar view" costs, said before the window opens rather than discovered on
 * stream.
 *
 * A browser stops producing frames for a page it considers not visible — a background tab,
 * a minimized window, *or one fully covered by another window* — and no page-level API opts
 * out of it. So the overlay window freezes exactly when a streamer has alt-tabbed, which is
 * the moment they cannot see that it has. There is nothing to fix in the overlay; the fix is
 * to not be a browser window at all, which is what Send to OBS is for.
 *
 * A native `<dialog>` in modal mode like `ConfirmDialog`, so focus trapping, Escape and the
 * inert backdrop come from the platform. It is not that component because the useful way out
 * of this warning is a third action — going to the OBS setup — and not the cancel.
 */
export function AvatarWindowNotice({
  open,
  onOpenAnyway,
  onClose,
}: {
  open: boolean;
  onOpenAnyway: () => void;
  onClose: () => void;
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
      style={{ border: 0, padding: "26px", maxWidth: "min(480px, 100%)" }}
      aria-labelledby="avatar-window-notice-title"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        // A click on the dialog element itself is a click on the backdrop — the content is
        // all in child elements.
        if (e.target === ref.current) onClose();
      }}
    >
      <div className="dialog-title" id="avatar-window-notice-title">
        Keep the avatar window visible
      </div>
      <div className="dialog-body">
        <p style={{ margin: 0 }}>
          The avatar only animates while its window is actually on your screen. Minimize it,
          switch to another tab, or just put another window in front of it and your browser
          stops drawing it — the avatar freezes mid-sentence until you uncover it again.
        </p>
        <p style={{ margin: "10px 0 0" }}>
          Capturing this window in OBS works, but only if you leave it uncovered for the whole
          stream. <strong>Send to OBS</strong> avoids that entirely: OBS draws the avatar as a
          browser source off-screen, so nothing can hide it.
        </p>
      </div>
      <div className="dialog-actions">
        <Link href="/avatar-config" className="btn btn-secondary" onClick={onClose}>
          Set up Send to OBS
        </Link>
        <button type="button" className="btn btn-primary" onClick={onOpenAnyway} autoFocus>
          Open the window
        </button>
      </div>
    </dialog>
  );
}
