"use client";

import { useSyncExternalStore, useEffect } from "react";
import { isInsideObs, postAvatarMessage, pushAvatarImagesToObs } from "./avatarStore";
import {
  applyObsConfig,
  getObsServerStatus,
  getObsStatus,
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
 */
export async function pushAvatarToObs(): Promise<boolean> {
  postAvatarMessage({ type: "settings", avatar: settingsStore.get().avatar });
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

  return useSyncExternalStore(subscribeObsStatus, getObsStatus, getObsServerStatus);
}
