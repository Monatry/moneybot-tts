"use client";

import { useSyncExternalStore, useEffect } from "react";
import { isInsideObs, postAvatarMessage, pushAvatarImagesToObs } from "./avatarStore";
import {
  applyObsConfig,
  getObsServerStatus,
  getObsStatus,
  isObsConnected,
  setObsReadyHandler,
  subscribeObsStatus,
  type ObsBridgeStatus,
} from "./obsBridge";
import { settingsStore, useSettings } from "./settings";

/**
 * Everything an OBS overlay needs, in the order it needs it.
 *
 * Sent on connect, and again from the config screen's Save. The settings go first so that a
 * browser source coming up mid-push has the geometry before it has anything to draw with it,
 * and the images go last because they are the slow part.
 *
 * `setup` leads, and carries the whole settings object rather than the avatar alone: an
 * overlay that has to run the bot by itself needs the channel, the token and the triggers as
 * well, and inside OBS there is no shared storage to read them from. It is the first message
 * because it is the one that decides whether that overlay can work at all — and because
 * `settings` immediately after it is what re-normalizes the half the overlay *draws*, so the
 * order matches how the receiving side is layered. See lib/avatarRunner.ts.
 */
export async function pushAvatarToObs(): Promise<boolean> {
  const settings = settingsStore.get();
  lastSetupSent = JSON.stringify(settings);
  postAvatarMessage({ type: "setup", settings });
  postAvatarMessage({ type: "settings", avatar: settings.avatar });
  return pushAvatarImagesToObs();
}

/**
 * How long to let OBS settle after it accepts the connection before pushing.
 *
 * The common way this connects is OBS starting while the dashboard is already open, and OBS
 * brings its WebSocket server up around the same time as it loads the scene collection —
 * not reliably after it. A push that wins that race is dispatched to a browser source that
 * has not yet attached its listener, and nothing about it can be retried, because the bridge
 * is one-way and the overlay cannot say it missed anything. Waiting a couple of seconds
 * costs nothing: the overlay is painting its cached set the whole time.
 */
const SETTLE_MS = 2000;

let settleTimer: number | undefined;

/**
 * The last configuration an overlay was told about, so a change can be spotted.
 *
 * Needed because a runner in OBS is holding a *copy* of the settings, and the screens that
 * edit them mostly are not the screens that talk to OBS: a trigger toggled on /setup, or a
 * re-authorised token, would otherwise not reach it until OBS reconnected. A whole `Settings`
 * is a few hundred bytes, so re-sending it on any change is cheaper than reasoning about
 * which fields a runner cares about.
 *
 * Module-level rather than a ref, so navigating between screens does not lose track of what
 * has already been sent and re-push on every mount.
 */
let lastSetupSent: string | null = null;
let setupTimer: number | undefined;

/** Debounced: a volume slider being dragged writes settings on every frame. */
const SETUP_DEBOUNCE_MS = 500;

function pushSetupIfChanged() {
  if (!isObsConnected()) return;
  const settings = settingsStore.get();
  const serialized = JSON.stringify(settings);
  if (serialized === lastSetupSent) return;
  lastSetupSent = serialized;
  postAvatarMessage({ type: "setup", settings });
}

/**
 * Keeps the bridge pointed at the stored settings, and reports its state.
 *
 * Used by the screens that drive the overlay — the dashboard and the avatar config — and
 * never by `/avatar` itself: an overlay has nothing to push, and one running inside OBS
 * would be dialling the obs-websocket of the OBS that is rendering it, to send itself
 * events it is already receiving.
 *
 * Deliberately does **not** disconnect on unmount. The bridge is a module singleton for the
 * same reason `bot.ts` is: moving between the dashboard and the config screen must not drop
 * the connection, and a React tree that unmounts on every navigation is the wrong lifetime
 * for a socket the queue is pushing through.
 */
export function useObsBridge(): ObsBridgeStatus {
  const settings = useSettings();
  const { enabled, url, password } = settings.obs;

  useEffect(() => {
    // A dashboard opened *inside* OBS would be talking to itself. Rare, but the loop it
    // creates is confusing enough to be worth one line.
    if (isInsideObs()) return;
    // Deliberately not cleared on unmount: the push it schedules touches no React state, and
    // navigating from the dashboard to the config screen mid-settle must not cancel the one
    // delivery a freshly connected OBS is going to get.
    setObsReadyHandler(() => {
      window.clearTimeout(settleTimer);
      settleTimer = window.setTimeout(() => void pushAvatarToObs(), SETTLE_MS);
    });
    applyObsConfig({ enabled, url, password });
  }, [enabled, url, password]);

  // Anything a runner reads may have changed. `useSettings` hands back a fresh object on every
  // store write, so this fires on all of them and the comparison inside decides.
  useEffect(() => {
    if (isInsideObs()) return;
    window.clearTimeout(setupTimer);
    setupTimer = window.setTimeout(pushSetupIfChanged, SETUP_DEBOUNCE_MS);
  }, [settings]);

  return useSyncExternalStore(subscribeObsStatus, getObsStatus, getObsServerStatus);
}
