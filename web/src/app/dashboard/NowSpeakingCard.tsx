"use client";

import { Pause, Play, SkipForward } from "lucide-react";
import { Coin } from "@/components/Coin";
import type { BotState } from "@/lib/bot";
import styles from "./dashboard.module.css";

/**
 * The now-speaking card. Doubles as the queue's empty state, which the handoff asks to read
 * as calm rather than as an error: the same gold card with the coin at rest.
 *
 * The coin bounces only while audio is actually reaching the device — the same gate the
 * avatar's mouth uses, and for the same reason. Synthesis is requested several hundred ms
 * before the first sample arrives.
 */
export function NowSpeakingCard({
  state,
  onSkip,
  onTogglePause,
}: {
  state: BotState;
  onSkip: () => void;
  onTogglePause: () => void;
}) {
  const now = state.nowPlaying;

  if (!now) {
    return (
      <div className={styles.nowCard}>
        <Coin size={56} tone="white" shadow={3} />
        <div className={styles.nowBody}>
          <div className={styles.nowEyebrow}>Nothing to read</div>
          <div className={styles.nowUtterance}>
            {state.queue.length > 0 ? "Waiting out the pacing gap…" : "Chat is quiet."}
          </div>
        </div>
      </div>
    );
  }

  const { request, progress } = now;
  return (
    <div className={styles.nowCard}>
      <Coin size={56} tone="white" shadow={3} bounce={state.isSpeaking} />
      <div className={styles.nowBody}>
        <div className={styles.nowHead}>
          <span className={styles.nowEyebrow}>Now speaking</span>
          {request.source === "cheer" && request.bits ? (
            <span className={styles.bitsChip}>{request.bits.toLocaleString()} bits</span>
          ) : null}
          {request.source === "redeem" ? <span className={styles.bitsChip}>Redeem</span> : null}
          {request.voice ? <span className={styles.voiceChip}>{request.voice}</span> : null}
        </div>
        <div className={styles.nowUtterance}>
          {request.user ? `${request.user}: ` : ""}
          {`“${request.text}”`}
        </div>
        <div className={styles.progressTrack}>
          <div className={styles.progressFill} style={{ width: `${Math.round(progress * 100)}%` }} />
        </div>
      </div>
      <div className={styles.nowActions}>
        <button
          type="button"
          className={`btn btn-secondary btn-icon ${styles.nowIconBtn}`}
          onClick={onTogglePause}
          aria-label={state.paused ? "Resume playback" : "Pause playback"}
          title={state.paused ? "Resume" : "Pause"}
        >
          {state.paused ? (
            <Play size={16} strokeWidth={2.75} />
          ) : (
            <Pause size={16} strokeWidth={2.75} />
          )}
        </button>
        <button type="button" className={`btn btn-dark ${styles.skipBtn}`} onClick={onSkip}>
          <SkipForward size={15} strokeWidth={2.75} />
          Skip
        </button>
      </div>
    </div>
  );
}
