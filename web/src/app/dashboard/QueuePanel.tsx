"use client";

import { MessageSquare, SkipForward, Star, Trash2, X } from "lucide-react";
import { useState } from "react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { MAX_QUEUE_ROWS } from "@/lib/bot";
import type { TtsRequest } from "@/lib/types";
import styles from "./dashboard.module.css";

export function QueuePanel({
  queue,
  holdRemaining,
  onSkipNext,
  onClear,
  onRemove,
}: {
  queue: TtsRequest[];
  holdRemaining: number;
  onSkipNext: () => void;
  onClear: () => void;
  onRemove: (id: string) => void;
}) {
  const [confirming, setConfirming] = useState(false);

  const totalSeconds = queue.reduce((sum, r) => sum + r.estSeconds, 0);
  // The queue itself is unbounded; the *list* of it is not. The whole list re-renders on
  // every change, so past this many rows it is summarised instead — the same cap the
  // desktop dashboard had.
  const shown = queue.slice(0, MAX_QUEUE_ROWS);
  const hidden = queue.length - shown.length;

  return (
    <section className={styles.queuePanel}>
      <header className={styles.queueHeader}>
        <h4 style={{ margin: 0 }}>Queue</h4>
        <span className="tag tag-neutral">
          {queue.length} waiting · {formatDuration(totalSeconds)}
        </span>
        {holdRemaining > 0 && (
          <span className={styles.holdTag}>next in {holdRemaining.toFixed(1)}s</span>
        )}
        <div className={styles.queueActions}>
          <button
            type="button"
            className={`btn btn-secondary ${styles.queueBtn}`}
            onClick={onSkipNext}
            disabled={queue.length === 0 && holdRemaining === 0}
          >
            <SkipForward size={14} strokeWidth={2.75} />
            Skip next
          </button>
          <button
            type="button"
            className={`btn btn-secondary btn-danger ${styles.queueBtn}`}
            onClick={() => setConfirming(true)}
            disabled={queue.length === 0}
          >
            <Trash2 size={14} strokeWidth={2.75} />
            Clear queue
          </button>
        </div>
      </header>

      <div className={styles.queueList}>
        {queue.length === 0 && (
          <p className={styles.queueEmpty}>Nothing to read, chat is quiet.</p>
        )}
        {shown.map((req, i) => (
          <QueueRow key={req.id} req={req} index={i + 1} onRemove={() => onRemove(req.id)} />
        ))}
        {hidden > 0 && (
          <p className={styles.queueEmpty}>
            …and {hidden} more waiting ({formatDuration(
              queue.slice(MAX_QUEUE_ROWS).reduce((s, r) => s + r.estSeconds, 0),
            )})
          </p>
        )}
      </div>

      <ConfirmDialog
        open={confirming}
        title="Clear the queue?"
        body={`${queue.length} message${queue.length === 1 ? "" : "s"} will be dropped. The one being read now keeps playing.`}
        confirmLabel="Clear queue"
        danger
        onCancel={() => setConfirming(false)}
        onConfirm={() => {
          setConfirming(false);
          onClear();
        }}
      />
    </section>
  );
}

function QueueRow({
  req,
  index,
  onRemove,
}: {
  req: TtsRequest;
  index: number;
  onRemove: () => void;
}) {
  return (
    <div className={`${styles.queueRow} ${styles[`row_${req.source}`]}`}>
      <span className={styles.rowIndex}>{index}</span>
      <span className={`${styles.rowBadge} ${styles[`badge_${req.source}`]}`} aria-hidden>
        {req.source === "cheer" ? (
          compactBits(req.bits ?? 0)
        ) : req.source === "redeem" ? (
          <Star size={13} strokeWidth={2.75} />
        ) : (
          <MessageSquare size={13} strokeWidth={2.75} />
        )}
      </span>
      <div className={styles.rowText}>
        <div className={styles.rowUser}>{req.user}</div>
        <div className={styles.rowMessage}>{`“${req.text}”`}</div>
      </div>
      <span className={`tag ${sourceTagClass(req.source)}`}>{sourceLabel(req.source)}</span>
      <span className={styles.rowDuration}>{formatDuration(req.estSeconds)}</span>
      <button
        type="button"
        className={styles.rowRemove}
        onClick={onRemove}
        aria-label={`Remove ${req.user}'s message from the queue`}
      >
        <X size={14} strokeWidth={2.75} />
      </button>
    </div>
  );
}

function sourceLabel(source: TtsRequest["source"]): string {
  return source === "cheer" ? "Cheer" : source === "redeem" ? "Redeem" : "Chat";
}

function sourceTagClass(source: TtsRequest["source"]): string {
  return source === "cheer" ? "tag-accent" : source === "redeem" ? "tag-accent-2" : "tag-neutral";
}

/** Bit counts sit in a 30px circle, so five digits have to become "12k". */
function compactBits(bits: number): string {
  if (bits >= 10000) return `${Math.round(bits / 1000)}k`;
  if (bits >= 1000) return `${(bits / 1000).toFixed(1)}k`;
  return String(bits);
}

export function formatDuration(seconds: number): string {
  const total = Math.round(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}m ${s}s` : `0:${String(s).padStart(2, "0")}`;
}
