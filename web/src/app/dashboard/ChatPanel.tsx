"use client";

import { useEffect, useRef, useState } from "react";
import type { ChatEntry } from "@/lib/types";
import styles from "./dashboard.module.css";

/**
 * The Twitch chat column. A mirror of the channel, independent of the triggers — a message
 * the queue is not reading still belongs here.
 *
 * There is no composer. The design draws one, but this build deliberately never sends as
 * the streamer: it reads chat and nothing else, which is also what the sign-in flow
 * promises.
 *
 * Auto-scroll follows the bottom and gives up the moment the streamer scrolls away, which
 * is the only way to read back through a fast chat.
 */
export function ChatPanel({
  chat,
  connected,
  viewerCount,
}: {
  chat: ChatEntry[];
  connected: boolean;
  viewerCount: number | null;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(true);

  useEffect(() => {
    if (!following) return;
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chat, following]);

  function onScroll() {
    const el = listRef.current;
    if (!el) return;
    // 40px of slack: a list that is one rounding error from the bottom is still "at" it.
    setFollowing(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
  }

  return (
    <section className={styles.chatColumn}>
      <header className={styles.chatHeader}>
        <h4 style={{ margin: 0 }}>Twitch chat</h4>
        {viewerCount !== null && (
          <span className={styles.chatViewers}>{viewerCount.toLocaleString()} viewers</span>
        )}
        <span className={connected ? styles.livePill : styles.offlinePill}>
          {connected ? "Live" : "Offline"}
        </span>
      </header>

      <div className={styles.chatList} ref={listRef} onScroll={onScroll}>
        {chat.length === 0 && (
          <p className={styles.chatEmpty}>
            {connected ? "Waiting for the first message…" : "Not connected to chat yet."}
          </p>
        )}
        {chat.map((entry) => (
          <ChatLine key={entry.id} entry={entry} />
        ))}
      </div>

      <div className={styles.chatFooter}>
        {following ? (
          <>
            <span className={styles.autoDot} aria-hidden />
            auto-scrolling
          </>
        ) : (
          <button type="button" className="btn btn-ghost" onClick={() => setFollowing(true)}>
            Jump to newest
          </button>
        )}
      </div>
    </section>
  );
}

function ChatLine({ entry }: { entry: ChatEntry }) {
  if (entry.kind === "cheer") {
    return (
      <div className={styles.cheerCard}>
        <span className={styles.cheerEyebrow}>cheered {entry.bits?.toLocaleString()} bits</span>
        <span className={styles.cheerName}>{entry.user}</span>
        <span className={styles.cheerBody}>: {entry.text}</span>
      </div>
    );
  }

  if (entry.kind === "redeem") {
    return (
      <div className={styles.redeemCard}>
        <span className={styles.redeemEyebrow}>redeemed {entry.rewardName}</span>
        <span className={styles.redeemName}>{entry.user}</span>
        {entry.text && <span className={styles.redeemBody}>: {entry.text}</span>}
      </div>
    );
  }

  return (
    <div className={styles.chatLine}>
      <span className={styles.chatName} style={{ color: entry.color }}>
        {entry.user}
      </span>
      <span className={styles.chatBody}>: {entry.text}</span>
    </div>
  );
}
