"use client";

/**
 * The way out of the profile boundary: a link from this window to browser sources running
 * inside OBS.
 *
 * The overlay normally reaches its window over BroadcastChannel, which needs both ends in
 * one browser profile. An OBS browser source is not in one — it is CEF, with its own
 * storage, its own IndexedDB and no BroadcastChannel peer here — so the overlay can only be
 * a *window* Chrome paints, which is why it stops animating the moment that window is
 * hidden or occluded.
 *
 * obs-websocket carries the missing hop. obs-browser registers a vendor named `obs-browser`
 * whose `emit_event` request dispatches a `CustomEvent` into every browser source, so
 * anything that can speak obs-websocket can push state into a page OBS is rendering. That
 * is this module: connect, identify, and relay each `postAvatarMessage` on as a vendor
 * request. The overlay picks it up with a plain `addEventListener` (see `avatarStore`).
 *
 * Three consequences worth knowing before changing anything here:
 *
 * - **It is one-way.** `window.obsstudio` exposes OBS *to* the page; it gives the page no
 *   way back out to obs-websocket. The overlay therefore cannot ask for anything — it can
 *   only be told — so the dashboard pushes the whole state on connect rather than answering
 *   a request, and the overlay caches what it receives against the next cold start.
 * - **`ws://` from an `https://` page is allowed here and only here.** Loopback is a
 *   potentially trustworthy origin, so `ws://127.0.0.1` is exempt from mixed-content
 *   blocking. Point this at a LAN address instead and the browser blocks it before it is
 *   sent, with no error worth reading.
 * - **`emit_event` reaches every browser source in OBS, not just ours.** Hence the
 *   namespaced event name below: a source that is not the overlay gets an event it has
 *   never heard of and ignores it.
 */

/** The `CustomEvent` name browser sources listen on. Namespaced — `emit_event` is a broadcast. */
export const OBS_EVENT_NAME = "moneybot.avatar";

export const DEFAULT_OBS_URL = "ws://127.0.0.1:4455";

export interface ObsBridgeConfig {
  enabled: boolean;
  /** `ws://127.0.0.1:4455` unless OBS was moved off its default port. */
  url: string;
  /** The password from OBS's Tools ▸ WebSocket Server Settings. Empty if auth is off there. */
  password: string;
}

export type ObsBridgeStatus =
  | { state: "off" }
  | { state: "connecting" }
  /** `note` carries a failed vendor request — connected, but the last push did not land. */
  | { state: "connected"; version: string; note: string | null }
  /** `retrying` false means the failure will not fix itself: a wrong password, a bad URL. */
  | { state: "error"; message: string; retrying: boolean };

const RECONNECT_MS = [1000, 2000, 5000, 10000, 30000];
/** Above this much unsent data, the image push waits rather than piling more on. */
const BUFFER_HIGH_WATER = 8 * 1024 * 1024;

let config: ObsBridgeConfig = { enabled: false, url: DEFAULT_OBS_URL, password: "" };
let socket: WebSocket | null = null;
let status: ObsBridgeStatus = { state: "off" };
let identified = false;
let opened = false;
let serverVersion = "";
let attempt = 0;
/**
 * A failure that retrying cannot fix — a rejected password, an unusable URL. Latched so that
 * navigating between the dashboard and the config screen, which re-runs the effect that
 * applies this config, does not re-dial OBS to be told the same thing again. Cleared only by
 * a config change, which is the only thing that could change the answer.
 */
let fatal = false;
let reconnectTimer: number | null = null;
let requestId = 0;
/**
 * Bumped on every (re)connect, so work that started against an older socket — the auth
 * digest is asynchronous — cannot land on a newer one.
 */
let generation = 0;
let onReady: (() => void) | null = null;

const listeners = new Set<() => void>();

function emitChange() {
  for (const l of listeners) l();
}

function setStatus(next: ObsBridgeStatus) {
  status = next;
  emitChange();
}

/** A note on the live connection, e.g. a vendor request OBS rejected. Never replaces the state. */
function setNote(note: string | null) {
  if (status.state !== "connected" || status.note === note) return;
  setStatus({ ...status, note });
}

function clearReconnect() {
  if (reconnectTimer !== null) {
    window.clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function teardown() {
  const ws = socket;
  socket = null;
  identified = false;
  opened = false;
  if (!ws) return;
  // Detached first: the close below would otherwise run the handler that schedules a
  // reconnect for a socket we are deliberately dropping.
  ws.onopen = null;
  ws.onmessage = null;
  ws.onerror = null;
  ws.onclose = null;
  try {
    ws.close();
  } catch {
    /* already closing */
  }
}

function sameConfig(a: ObsBridgeConfig, b: ObsBridgeConfig): boolean {
  return a.enabled === b.enabled && a.url === b.url && a.password === b.password;
}

/**
 * Point the bridge at a configuration. Idempotent: called from a React effect on every
 * settings change, and an unchanged config with a live socket is a no-op rather than a
 * reconnect — otherwise typing in the password field would drop the connection per keystroke.
 */
export function applyObsConfig(next: ObsBridgeConfig) {
  const unchanged = sameConfig(config, next);
  config = next;
  if (unchanged && (socket || fatal || !next.enabled)) return;
  connect();
}

/**
 * What to run once the connection is live. A single slot rather than a listener set: both
 * screens that start the bridge register the same "push everything" handler, and a set would
 * push once per mounted screen.
 */
export function setObsReadyHandler(fn: (() => void) | null) {
  onReady = fn;
}

export function getObsStatus(): ObsBridgeStatus {
  return status;
}

export function subscribeObsStatus(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The value React's server render and hydrating render both see. */
export function getObsServerStatus(): ObsBridgeStatus {
  return OFF;
}
const OFF: ObsBridgeStatus = { state: "off" };

export function isObsConnected(): boolean {
  return identified && socket !== null;
}

function connect() {
  const gen = ++generation;
  clearReconnect();
  teardown();
  fatal = false;

  if (!config.enabled) {
    setStatus({ state: "off" });
    return;
  }
  if (typeof WebSocket === "undefined") return;

  let ws: WebSocket;
  try {
    ws = new WebSocket(config.url);
  } catch {
    // A malformed URL throws here rather than failing asynchronously, and no amount of
    // retrying will improve it.
    fatal = true;
    setStatus({
      state: "error",
      message: `${config.url || "(empty)"} is not a WebSocket address. It should look like ${DEFAULT_OBS_URL}.`,
      retrying: false,
    });
    return;
  }

  socket = ws;
  setStatus({ state: "connecting" });

  ws.onopen = () => {
    if (gen === generation) opened = true;
  };
  ws.onmessage = (ev) => void handleMessage(ev, gen);
  // The error event carries nothing useful by design; `onclose` always follows it and is
  // where the reason actually is.
  ws.onerror = () => {};
  ws.onclose = (ev) => {
    if (gen !== generation) return;
    const wasOpen = opened;
    socket = null;
    identified = false;
    opened = false;
    fatal = ev.code === 4009 || ev.code === 4010;
    setStatus({ state: "error", message: closeMessage(ev, wasOpen), retrying: !fatal });
    if (!fatal) scheduleReconnect();
  };
}

function closeMessage(ev: CloseEvent, wasOpen: boolean): string {
  // https://github.com/obsproject/obs-websocket/blob/master/docs/generated/protocol.md
  if (ev.code === 4009) return "OBS rejected the password. Check Tools ▸ WebSocket Server Settings.";
  if (ev.code === 4010) return "OBS is speaking a WebSocket protocol version this build does not know.";
  if (ev.code === 4011) return "OBS closed the session (it was invalidated).";
  if (!wasOpen) {
    return `Could not reach OBS at ${config.url}. Is it running, with Tools ▸ WebSocket Server Settings enabled?`;
  }
  return `OBS closed the connection${ev.code ? ` (code ${ev.code})` : ""}.`;
}

function scheduleReconnect() {
  clearReconnect();
  const wait = RECONNECT_MS[Math.min(attempt, RECONNECT_MS.length - 1)];
  attempt += 1;
  reconnectTimer = window.setTimeout(connect, wait);
}

/** Only the fields this bridge reads, across all three opcodes it handles. */
interface ObsPayload {
  obsWebSocketVersion?: string;
  rpcVersion?: number;
  authentication?: { challenge: string; salt: string };
  requestStatus?: { result?: boolean; code?: number; comment?: string };
}

async function handleMessage(ev: MessageEvent, gen: number) {
  if (gen !== generation) return;

  let msg: { op?: number; d?: ObsPayload };
  try {
    msg = JSON.parse(String(ev.data));
  } catch {
    return;
  }
  const d: ObsPayload = msg.d ?? {};

  // Hello → Identify.
  if (msg.op === 0) {
    serverVersion = String(d.obsWebSocketVersion ?? "");
    const auth = d.authentication;
    const identify: Record<string, unknown> = {
      rpcVersion: d.rpcVersion ?? 1,
      // No OBS events are wanted — this is a one-way pipe out. Subscribing to the default
      // set would stream scene and source changes at us for nothing.
      eventSubscriptions: 0,
    };
    if (auth) {
      if (!config.password) {
        fatal = true;
        setStatus({
          state: "error",
          message: "OBS is asking for a password. Copy it from Tools ▸ WebSocket Server Settings.",
          retrying: false,
        });
        teardown();
        return;
      }
      identify.authentication = await authString(config.password, auth.salt, auth.challenge);
      // The digest above is a trip through the crypto API, and the socket may be long gone
      // by the time it resolves.
      if (gen !== generation || !socket) return;
    }
    send({ op: 1, d: identify });
    return;
  }

  // Identified.
  if (msg.op === 2) {
    identified = true;
    attempt = 0;
    setStatus({ state: "connected", version: serverVersion, note: null });
    onReady?.();
    return;
  }

  // RequestResponse. Emits are fire-and-forget, so this exists only to surface a rejection:
  // the one that matters is obs-browser not being there to take the vendor request.
  if (msg.op === 7) {
    if (d.requestStatus?.result === false) {
      const code = d.requestStatus.code;
      setNote(
        code === 604 || code === 600
          ? "OBS took the connection but has no browser source to deliver to."
          : `OBS rejected the last update${d.requestStatus.comment ? `: ${d.requestStatus.comment}` : ""}.`,
      );
    } else {
      setNote(null);
    }
  }
}

function send(message: unknown) {
  try {
    socket?.send(JSON.stringify(message));
  } catch {
    // A socket that dies mid-send raises `close` on its own; nothing useful to add here.
  }
}

/**
 * obs-websocket v5 authentication:
 * `base64(sha256(base64(sha256(password + salt)) + challenge))`.
 */
async function authString(password: string, salt: string, challenge: string): Promise<string> {
  const secret = await sha256Base64(password + salt);
  return sha256Base64(secret + challenge);
}

async function sha256Base64(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  const bytes = new Uint8Array(digest);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * Push one payload into every browser source. Returns whether it went out — callers treat a
 * `false` as "OBS is not listening", never as an error worth showing.
 */
export function emitToObs(payload: unknown): boolean {
  if (!identified || !socket) return false;
  requestId += 1;
  send({
    op: 6,
    d: {
      requestType: "CallVendorRequest",
      requestId: `moneybot-${requestId}`,
      requestData: {
        vendorName: "obs-browser",
        requestType: "emit_event",
        requestData: { event_name: OBS_EVENT_NAME, event_data: payload },
      },
    },
  });
  return true;
}

/**
 * Resolves once the socket has drained enough to take more.
 *
 * The avatar images are the one thing here that is measured in megabytes, and they go one
 * per message. Queuing all of them at once would hand the socket tens of megabytes in a
 * single tick, which stalls the speaking updates behind it — the one payload that has to be
 * timely. Gives up after ~5 s so a wedged socket cannot hang the push forever.
 */
export async function waitForObsDrain(): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (!socket || socket.bufferedAmount < BUFFER_HIGH_WATER) return;
    await new Promise((r) => setTimeout(r, 50));
  }
}
