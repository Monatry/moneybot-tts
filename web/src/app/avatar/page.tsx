"use client";

import { useEffect, useState } from "react";
import { AvatarStage } from "@/components/AvatarStage";
import {
  cacheAvatar,
  createImageReceiver,
  isInsideObs,
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
 * It shares no React tree with the dashboard — it is a separate window, and in the case this
 * route exists for, a separate *browser*. Which of the two it is decides where everything it
 * paints comes from:
 *
 * - **A window of the same browser.** Images come from IndexedDB, which the dashboard wrote,
 *   and state arrives over BroadcastChannel.
 * - **An OBS browser source.** CEF has its own storage and no BroadcastChannel peer here, so
 *   both arrive over the obs-websocket bridge instead. The images are then kept in *this*
 *   profile's IndexedDB, which is what a restarted OBS paints from before the dashboard has
 *   reconnected — the bridge is one-way, so an overlay cannot ask for them back.
 *
 * Neither case is detected up front: it subscribes to both transports and paints whatever
 * arrives.
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

    // Stateful across messages — an image set arrives in pieces and is applied only once the
    // count `images-begin` promised has been assembled.
    const receiver = createImageReceiver((complete) => {
      if (cancelled) return;
      setIdle(complete.idle);
      setFrames(complete.frames);
      void cacheAvatar(complete);
    });
    const inObs = isInsideObs();

    const unsubscribe = subscribeAvatarMessages((m: AvatarMessage) => {
      if (m.type === "speaking") {
        setSpeaking(m.speaking);
        setSpokenText(m.text);
      } else if (m.type === "settings") {
        // Normalized again on arrival: the message crosses a window boundary, so this is the
        // one path into these values that has not been through the settings store.
        setAvatar(normalizeAvatar(m.avatar));
      } else if (m.type === "config-changed") {
        // Only worth acting on where the dashboard and this window share a store. Inside OBS
        // the store is this overlay's own cache, so re-reading it would repaint the images
        // that are about to be replaced by the push following this ping.
        if (!inObs) refresh();
      } else {
        receiver.accept(m);
      }
    });
    return () => {
      cancelled = true;
      unsubscribe();
      receiver.dispose();
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
