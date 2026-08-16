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

/* ── overlay channel ─────────────────────────────────────────────────────────────────
 * The /avatar route is opened in its own window (an OBS browser source, usually), so it
 * shares no React tree with the dashboard. BroadcastChannel is how the two talk: the
 * dashboard posts speaking state as it changes, and any screen that edits the avatar posts
 * a config-changed ping that makes the overlay re-read IndexedDB.
 */

const CHANNEL = "moneybot-avatar";

export type AvatarMessage =
  /** Images changed — the overlay re-reads IndexedDB. */
  | { type: "config-changed" }
  /**
   * The whole `settings.avatar` object. Sent whole rather than field by field: the overlay
   * hydrated its own copy of localStorage when it opened and never sees a later write from
   * the dashboard window, so every field it paints has to arrive here.
   */
  | { type: "settings"; avatar: AvatarSettings }
  /** Whether samples are reaching the device, plus the line they belong to (for the caption). */
  | { type: "speaking"; speaking: boolean; text: string | null };

let channel: BroadcastChannel | null = null;

function getChannel(): BroadcastChannel | null {
  if (typeof window === "undefined" || typeof BroadcastChannel === "undefined") return null;
  if (!channel) channel = new BroadcastChannel(CHANNEL);
  return channel;
}

export function postAvatarMessage(message: AvatarMessage) {
  getChannel()?.postMessage(message);
}

function broadcastConfigChanged() {
  postAvatarMessage({ type: "config-changed" });
}

export function subscribeAvatarMessages(fn: (m: AvatarMessage) => void): () => void {
  if (typeof window === "undefined" || typeof BroadcastChannel === "undefined") return () => {};
  // A dedicated instance per subscriber: closing a shared one when the first subscriber
  // unmounts would silence the rest.
  const ch = new BroadcastChannel(CHANNEL);
  const handler = (ev: MessageEvent) => fn(ev.data as AvatarMessage);
  ch.addEventListener("message", handler);
  return () => {
    ch.removeEventListener("message", handler);
    ch.close();
  };
}
