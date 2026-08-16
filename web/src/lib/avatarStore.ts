"use client";

/**
 * Storage for the avatar images, and the channel that keeps the overlay window in step
 * with the app.
 *
 * The desktop build read an `Avatar` folder sitting next to the exe: `idle.png` plus
 * numbered frames. A website has no folder, so the design replaces it with uploads — and
 * uploads of up to 4 MB each cannot live in localStorage next to the settings, so they go
 * in IndexedDB as Blobs. Only the counts are mirrored into `settings.avatar`, which is what
 * the UI can render before the blobs have loaded.
 *
 * The rule the desktop build had still holds: only the idle image gates the feature. A set
 * with no talking frames is a valid static avatar, not a broken one.
 */

import { OBS_EVENT_NAME, emitToObs, waitForObsDrain } from "./obsBridge";
import type { AvatarSettings } from "./settings";

const DB_NAME = "moneybot-avatar";
const DB_VERSION = 1;
const STORE = "images";

const IDLE_KEY = "idle";
const FRAMES_KEY = "frames";

/** Per the design's dropzone copy: "PNG or GIF with transparency, up to 4 MB". */
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
export const ACCEPTED_TYPES = ["image/png", "image/gif", "image/webp", "image/jpeg"];

export interface StoredImage {
  name: string;
  blob: Blob;
  width: number;
  height: number;
}

export interface AvatarData {
  idle: StoredImage | null;
  frames: StoredImage[];
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("Could not open the avatar store"));
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest,
): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      req.onsuccess = () => resolve(req.result as T);
      req.onerror = () => reject(req.error ?? new Error("Avatar store request failed"));
    });
  } finally {
    db.close();
  }
}

export async function loadAvatar(): Promise<AvatarData> {
  try {
    const idle = await withStore<StoredImage | undefined>("readonly", (s) => s.get(IDLE_KEY));
    const frames = await withStore<StoredImage[] | undefined>("readonly", (s) => s.get(FRAMES_KEY));
    return { idle: idle ?? null, frames: frames ?? [] };
  } catch {
    // An optional cosmetic extra must never be able to stop the app from working — the
    // desktop `AvatarSet.TryLoad` had the same rule.
    return { idle: null, frames: [] };
  }
}

export class ImageRejected extends Error {}

/** Validates and decodes one file. Throws `ImageRejected` with a message fit to display. */
export async function prepareImage(file: File): Promise<StoredImage> {
  if (!ACCEPTED_TYPES.includes(file.type)) {
    throw new ImageRejected(`${file.name} is not a PNG, GIF, WebP or JPEG.`);
  }
  if (file.size > MAX_IMAGE_BYTES) {
    throw new ImageRejected(
      `${file.name} is ${(file.size / 1024 / 1024).toFixed(1)} MB, the limit is 4 MB.`,
    );
  }

  const url = URL.createObjectURL(file);
  try {
    const { width, height } = await new Promise<{ width: number; height: number }>(
      (resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
        img.onerror = () => reject(new ImageRejected(`${file.name} could not be decoded.`));
        img.src = url;
      },
    );
    return { name: file.name, blob: file, width, height };
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function saveIdle(image: StoredImage | null): Promise<void> {
  await withStore("readwrite", (s) => (image ? s.put(image, IDLE_KEY) : s.delete(IDLE_KEY)));
  broadcastConfigChanged();
}

export async function saveFrames(frames: StoredImage[]): Promise<void> {
  await withStore("readwrite", (s) => s.put(frames, FRAMES_KEY));
  broadcastConfigChanged();
}

export async function resetAvatar(): Promise<void> {
  await withStore("readwrite", (s) => s.delete(IDLE_KEY));
  await withStore("readwrite", (s) => s.delete(FRAMES_KEY));
  broadcastConfigChanged();
}

/**
 * Write a received image set into *this* browser's store without telling anyone.
 *
 * Only the overlay running inside OBS calls this, and what it is writing is a copy of the
 * dashboard's images that arrived over the bridge. It is a cache, not an edit: the config
 * ping the saves above send would come straight back to the only subscriber in that CEF
 * profile — itself — and make it re-read what it just wrote.
 */
export async function cacheAvatar(data: AvatarData): Promise<void> {
  try {
    await withStore("readwrite", (s) => (data.idle ? s.put(data.idle, IDLE_KEY) : s.delete(IDLE_KEY)));
    await withStore("readwrite", (s) => s.put(data.frames, FRAMES_KEY));
  } catch {
    // The cache only saves a cold start from being blank until the dashboard next pushes.
    // Losing it is not worth surfacing in a live scene.
  }
}

/* ── overlay channel ─────────────────────────────────────────────────────────────────
 * The /avatar route is opened in its own window, so it shares no React tree with the
 * dashboard. It talks over two transports at once, and neither end picks:
 *
 * - **BroadcastChannel**, for an overlay in a window of this same browser profile. The
 *   dashboard posts speaking state as it changes, and any screen that edits the avatar posts
 *   a config-changed ping that makes the overlay re-read IndexedDB — both windows share it.
 * - **The OBS bridge**, for an overlay running as a browser source. CEF is a different
 *   profile: no BroadcastChannel peer, and an IndexedDB the dashboard cannot write. So the
 *   same messages go out as obs-websocket vendor events, and the *images* have to travel
 *   with them (`images-begin` … `image` … `images-end`) rather than being pointed at.
 *
 * Every message is sent on both. A window overlay ignores the image messages because it can
 * read the real blobs itself; an OBS overlay ignores `config-changed` because re-reading its
 * own store would tell it nothing new.
 */

const CHANNEL = "moneybot-avatar";

export type AvatarMessage =
  /** Images changed — an overlay sharing this profile re-reads IndexedDB. */
  | { type: "config-changed" }
  /**
   * The whole `settings.avatar` object. Sent whole rather than field by field: the overlay
   * hydrated its own copy of localStorage when it opened and never sees a later write from
   * the dashboard window, so every field it paints has to arrive here.
   */
  | { type: "settings"; avatar: AvatarSettings }
  /** Whether samples are reaching the device, plus the line they belong to (for the caption). */
  | { type: "speaking"; speaking: boolean; text: string | null }
  /**
   * An image set, for an overlay that cannot reach this profile's IndexedDB.
   *
   * **Chunked, and it has to be.** The route to a browser source ends in obs-browser
   * concatenating a `new CustomEvent(...)` script around the payload and `Eval`ing it in the
   * renderer — where a thrown exception is captured and then ignored. There is no error at
   * either end, so an oversized payload looks exactly like an overlay that ignored the
   * message. `settings` at a few hundred bytes arrives; a 4 MB image as one message does
   * not. So an image goes as a head plus `parts` slices of its base64, each `CHUNK_CHARS`.
   *
   * **Every message carries the `push` it belongs to.** A push takes seconds at this message
   * count, and there are three things that start one (connecting, Save, and the button), so
   * two streams overlapping is ordinary rather than exotic. Without the tag the receiver
   * cannot tell them apart: a second `images-begin` resets the set the first was still
   * filling, and parts land against the wrong head. The symptom is a set that arrives
   * *partially*, differently each time — not a clean failure.
   *
   * A `count` of 0 is a real, empty set (the avatar was reset).
   */
  | { type: "images-begin"; push: number; count: number }
  | {
      type: "image-head";
      push: number;
      slot: "idle" | "frame";
      /** Position within the talking frames; ignored for the idle image. */
      index: number;
      name: string;
      width: number;
      height: number;
      mime: string;
      parts: number;
    }
  /** One slice of the base64 of the image the last `image-head` opened. */
  | { type: "image-part"; push: number; part: number; data: string }
  | { type: "images-end"; push: number };

let channel: BroadcastChannel | null = null;

function getChannel(): BroadcastChannel | null {
  if (typeof window === "undefined" || typeof BroadcastChannel === "undefined") return null;
  if (!channel) channel = new BroadcastChannel(CHANNEL);
  return channel;
}

export function postAvatarMessage(message: AvatarMessage) {
  getChannel()?.postMessage(message);
  // Fans out to OBS as well. A no-op when the bridge is off or not connected, which is the
  // normal case — nothing above this line knows or cares whether OBS is listening.
  emitToObs(message);
}

function broadcastConfigChanged() {
  postAvatarMessage({ type: "config-changed" });
}

/**
 * Send the images themselves to OBS.
 *
 * Only ever called deliberately — on connect, and from the config screen's Save — because
 * this is megabytes where every other message is bytes. The bridge is one-way, so an overlay
 * that comes up after this has run cannot ask for a repeat; that is what its own cache and
 * the config screen's "Send to OBS" are for.
 */
export async function pushAvatarImagesToObs(): Promise<boolean> {
  // Latest wins. A push in flight is abandoned the moment another starts rather than the two
  // being interleaved — the receiver would discard the older one's messages anyway, and
  // finishing a stream nobody is assembling is minutes of pointless traffic.
  const push = ++pushSeq;
  const superseded = () => push !== pushSeq;

  const { idle, frames } = await loadAvatar();
  const count = (idle ? 1 : 0) + frames.length;
  if (!emitToObs({ type: "images-begin", push, count } satisfies AvatarMessage)) return false;

  const send = async (image: StoredImage, slot: "idle" | "frame", index: number) => {
    const dataUrl = await blobToDataUrl(image.blob);
    const comma = dataUrl.indexOf(",");
    const header = dataUrl.slice(0, comma);
    const semi = header.indexOf(";");
    const base64 = dataUrl.slice(comma + 1);
    const parts = Math.max(1, Math.ceil(base64.length / CHUNK_CHARS));

    emitToObs({
      type: "image-head",
      push,
      slot,
      index,
      name: image.name,
      width: image.width,
      height: image.height,
      mime: header.slice(5, semi > 0 ? semi : undefined) || "image/png",
      parts,
    } satisfies AvatarMessage);

    for (let part = 0; part < parts; part++) {
      if (superseded()) return;
      // Paced, not just drained. `bufferedAmount` only sees as far as the local socket,
      // which is never the bottleneck — everything downstream of it (the vendor request, the
      // process message, an `Eval` per message in the renderer) is invisible from here, so
      // the only way to be gentle with it is to actually wait.
      await waitForObsDrain();
      await delay(PACE_MS);
      emitToObs({
        type: "image-part",
        push,
        part,
        data: base64.slice(part * CHUNK_CHARS, (part + 1) * CHUNK_CHARS),
      } satisfies AvatarMessage);
    }
  };

  if (idle) await send(idle, "idle", 0);
  for (const [i, frame] of frames.entries()) {
    if (superseded()) return false;
    await send(frame, "frame", i);
  }

  if (superseded()) return false;
  // Held back rather than sent on the heels of the last slice. The receiver commits on the
  // count and treats this only as a hint, so the wait is not load-bearing — but sending it
  // into the tail of the traffic it is meant to terminate is asking for it to be handled
  // first, and then the grace period is paid on a set that was never actually short.
  await delay(END_LEAD_MS);
  return emitToObs({ type: "images-end", push } satisfies AvatarMessage);
}

let pushSeq = 0;

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Base64 characters per `image-part`, and the wait between them.
 *
 * Sized against the narrowest hop, which is not the WebSocket: obs-websocket takes a
 * multi-megabyte frame happily, and OBS then has to get it into the browser source's
 * renderer, which it does by `Eval`ing a script it built around the payload — where an
 * exception is swallowed rather than reported. Both numbers are therefore empirical, and
 * both are deliberately unambitious: a 4 MB image is ~340 messages and about a second and a
 * half, which is a one-time cost paid while the overlay carries on painting its cached set.
 *
 * If images stop arriving again, these two are the first things to reach for — smaller and
 * slower, in that order.
 */
const CHUNK_CHARS = 16 * 1024;
const PACE_MS = 4;
/** Quiet left after the last slice before `images-end` follows it. */
const END_LEAD_MS = 250;

/**
 * How long `images-end` waits for an image that has not finished arriving.
 *
 * `images-end` is not a reliable finalizer: it is emitted straight after the last slice, and
 * OBS delivers each message by queueing a process message and evaluating a script in the
 * renderer — a pipeline with no ordering guarantee this side can lean on. An end that
 * overtakes the tail of the last image closes the set while that image is still in pieces,
 * which is the whole of the "one image short, every time" failure. So it is treated as a
 * hint, not an instruction.
 */
const END_GRACE_MS = 2000;

/**
 * Reassembles an image set from the messages above and hands over each finished one.
 *
 * Stateful and deliberately not React state: the parts arrive over an event listener at
 * whatever rate the transport manages, and re-rendering the overlay once per megabyte of
 * half-arrived avatar would be visible in the scene.
 *
 * **It commits on the count, not on `images-end`** — `images-begin` says how many images are
 * coming, so the arrival of the last one is the real end of the set and nothing can overtake
 * it. `images-end` only starts a grace timer for the case where something genuinely did not
 * arrive, after which whatever is in hand is applied rather than discarded.
 *
 * Returns a disposer alongside the handler: the grace timer must not fire into an unmounted
 * overlay.
 */
export function createImageReceiver(onSet: (data: AvatarData) => void): {
  accept: (m: AvatarMessage) => void;
  dispose: () => void;
} {
  let staging: AvatarData | null = null;
  /** The push being assembled. Messages tagged with any other one are from an abandoned stream. */
  let active: number | null = null;
  let expected = 0;
  let got = 0;
  /** The image `image-head` opened, filling up as its parts arrive. */
  let pending: { head: Extract<AvatarMessage, { type: "image-head" }>; parts: string[] } | null =
    null;
  let grace: ReturnType<typeof setTimeout> | undefined;

  const partsIn = (p: string[]) => p.filter((x) => typeof x === "string").length;

  // Logged rather than shown: a browser source has no visible console, so this costs a live
  // scene nothing — and it is the only readout there is, for whoever has attached devtools
  // over OBS's remote debugging port.
  function commit(complete: boolean) {
    clearTimeout(grace);
    const done = staging;
    staging = null;
    active = null;
    if (!done) return;

    if (!complete) {
      if (pending) {
        console.warn(
          `[moneybot] avatar image "${pending.head.name}" never finished: ` +
            `${partsIn(pending.parts)}/${pending.head.parts} parts`,
        );
      }
      // Applied anyway. The frames are positional but the gaps are compacted out below, so an
      // incomplete set is a shorter talking cycle rather than a blank flash in it — and a
      // shorter cycle beats what the alternative leaves in the scene, which is whatever was
      // there before, or nothing at all on a first run.
      console.warn(
        `[moneybot] avatar image set incomplete: ${got}/${expected} images arrived, applying anyway`,
      );
    } else {
      console.info(`[moneybot] avatar image set applied: ${got} image(s)`);
    }
    pending = null;
    if (got === 0) return;
    onSet({ idle: done.idle, frames: done.frames.filter(Boolean) });
  }

  function accept(m: AvatarMessage) {
    if (m.type === "images-begin") {
      clearTimeout(grace);
      staging = { idle: null, frames: [] };
      pending = null;
      active = m.push;
      expected = m.count;
      got = 0;
      // An empty set is a real one — the avatar was reset, and the overlay should go blank.
      if (expected === 0) commit(true);
      return;
    }

    // Anything from a push that is not the one being assembled is from a stream that was
    // abandoned mid-flight. Dropping it here is what keeps two overlapping pushes from
    // combining into one corrupt set.
    if (m.type !== "images-end" && m.type !== "image-head" && m.type !== "image-part") return;
    if (m.push !== active) return;

    if (m.type === "image-head") {
      if (pending) {
        console.warn(
          `[moneybot] avatar image "${pending.head.name}" incomplete: ` +
            `${partsIn(pending.parts)}/${pending.head.parts} parts`,
        );
      }
      pending = staging ? { head: m, parts: [] } : null;
      return;
    }

    if (m.type === "image-part") {
      if (!pending || !staging) return;
      pending.parts[m.part] = m.data;
      if (partsIn(pending.parts) < pending.head.parts) return;

      const { head } = pending;
      const image: StoredImage = {
        name: head.name,
        blob: base64ToBlob(pending.parts.join(""), head.mime),
        width: head.width,
        height: head.height,
      };
      if (head.slot === "idle") staging.idle = image;
      else staging.frames[head.index] = image;
      pending = null;
      got += 1;
      console.info(`[moneybot] avatar image ${got}/${expected} received: ${head.name}`);
      // The count is the end of the set. Whether `images-end` has already been and gone, or
      // has not arrived yet, makes no difference from here.
      if (got >= expected) commit(true);
      return;
    }

    if (m.type === "images-end") {
      if (!staging) return;
      clearTimeout(grace);
      grace = setTimeout(() => commit(false), END_GRACE_MS);
    }
  }

  return { accept, dispose: () => clearTimeout(grace) };
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("Could not encode an avatar image"));
    reader.readAsDataURL(blob);
  });
}

/**
 * Decoded by hand rather than by `fetch(dataUrl)`: this runs inside an OBS browser source,
 * and a data-URL fetch is the kind of thing a page's CSP or an embedder's defaults quietly
 * refuse. `atob` has neither dependency.
 */
function base64ToBlob(base64: string, type: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type });
}

/** True inside an OBS browser source — obs-browser injects this object into every page. */
export function isInsideObs(): boolean {
  return typeof window !== "undefined" && "obsstudio" in window;
}

export function subscribeAvatarMessages(fn: (m: AvatarMessage) => void): () => void {
  if (typeof window === "undefined") return () => {};

  // A dedicated BroadcastChannel per subscriber: closing a shared one when the first
  // subscriber unmounts would silence the rest.
  const ch = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(CHANNEL);
  const onBroadcast = (ev: MessageEvent) => fn(ev.data as AvatarMessage);
  ch?.addEventListener("message", onBroadcast);

  // obs-browser dispatches `emit_event`'s payload as a CustomEvent on window. Listened for
  // unconditionally: it costs nothing outside OBS, where nothing ever fires it.
  const onObs = (ev: Event) => {
    const detail = (ev as CustomEvent).detail;
    if (detail && typeof detail === "object") fn(detail as AvatarMessage);
  };
  window.addEventListener(OBS_EVENT_NAME, onObs);

  return () => {
    ch?.removeEventListener("message", onBroadcast);
    ch?.close();
    window.removeEventListener(OBS_EVENT_NAME, onObs);
  };
}
