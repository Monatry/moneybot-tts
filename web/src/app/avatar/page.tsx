"use client";

import { useEffect, useState } from "react";
import { AvatarStage } from "@/components/AvatarStage";
import {
  loadAvatar,
  subscribeAvatarMessages,
  type AvatarMessage,
  type StoredImage,
} from "@/lib/avatarStore";
import { useObjectUrl, useObjectUrls } from "@/lib/useObjectUrls";
import { DEFAULT_AVATAR, normalizeAvatar, settingsStore, type AvatarSettings } from "@/lib/settings";
import styles from "./overlay.module.css";

/**
 * The browser-source overlay — the URL a streamer pastes into OBS.
 *
 * The handoff leaves this one deliberately undesigned ("the avatar view itself … was not
 * designed — only its configuration screen"), so it is built to the behaviour the config
 * screen describes and nothing more: idle image when quiet, talking frames cycling at the
 * configured fps while a message is being read, plus whichever of the opt-in effects
 * (crossfade, caption, bob) have been switched on there.
 *
 * With no images uploaded it draws **nothing**. A placeholder here would be a logo sitting
 * in the middle of a live scene until the streamer noticed it.
 *
 * It shares no React tree with the dashboard — it is a separate window. Images come from
 * IndexedDB (same origin), and speaking state arrives over BroadcastChannel.
 */
export default function AvatarOverlay() {
  const [idle, setIdle] = useState<StoredImage | null>(null);
  const [frames, setFrames] = useState<StoredImage[]>([]);
  const [speaking, setSpeaking] = useState(false);
  const [spokenText, setSpokenText] = useState<string | null>(null);
  const [avatar, setAvatar] = useState<AvatarSettings>(DEFAULT_AVATAR);

  const idleUrl = useObjectUrl(idle);
  const frameUrls = useObjectUrls(frames);

  // OBS composites whatever the page paints; a white body would be an opaque white box over
  // the scene. The overlay is the one route that must not inherit the app's page colour, so
  // the body carries the configured background — chroma-key green by default, or
  // `transparent` for a browser source that composites directly.
  useEffect(() => {
    const previous = document.body.style.background;
    document.body.style.background = avatar.background;
    return () => {
      document.body.style.background = previous;
    };
  }, [avatar.background]);

  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      void loadAvatar().then((data) => {
        if (cancelled) return;
        setIdle(data.idle);
        setFrames(data.frames);
      });
      // Read once, on open. Every later change arrives as a `settings` message: this window
      // hydrated its own copy of localStorage and never sees the dashboard's writes.
      setAvatar(settingsStore.get().avatar);
    };
    refresh();

    const unsubscribe = subscribeAvatarMessages((m: AvatarMessage) => {
      if (m.type === "speaking") {
        setSpeaking(m.speaking);
        setSpokenText(m.text);
      } else if (m.type === "settings") {
        // Normalized again on arrival: the message crosses a window boundary, so this is the
        // one path into these values that has not been through the settings store.
        setAvatar(normalizeAvatar(m.avatar));
      } else refresh();
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  return (
    <main className={styles.overlay} style={{ background: avatar.background }}>
      <AvatarStage
        idleUrl={idleUrl}
        frameUrls={frameUrls}
        speaking={speaking}
        avatar={avatar}
        captionText={spokenText}
      />
    </main>
  );
}
