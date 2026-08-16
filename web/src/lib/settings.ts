"use client";

import { useSyncExternalStore } from "react";

/**
 * Everything the app remembers between visits, in the shape the handoff's "State
 * Management" section lays out.
 *
 * Storage is localStorage, per the design's own promise on the setup screen ("Settings live
 * in your browser — nothing leaves this machine"). The desktop app wrapped the token in
 * Windows DPAPI; a browser has no equivalent, so the token sits in plaintext under this
 * origin. It is a scoped, revocable, non-refreshable implicit-flow token and it is never
 * sent anywhere but Twitch — see README, "Token storage".
 *
 * Avatar *images* are deliberately not here: they are blobs of up to 4 MB each and would
 * blow the ~5 MB localStorage budget. They live in IndexedDB (lib/avatarStore.ts); this
 * only carries the counts the UI needs before the blobs have loaded.
 */
export interface Settings {
  auth: {
    channel: string;
    token: string | null;
    /** Login of the token's *owner*, from the validate response. Not the same as `channel`. */
    login: string | null;
    userId: string | null;
    scopes: string[];
  };
  triggers: {
    chat: boolean;
    cheers: { enabled: boolean; minBits: number };
    redeems: { enabled: boolean; rewardName: string };
  };
  audio: {
    outputDeviceId: string;
    playbackRate: number;
    minDelayMs: number;
    masterVolume: number;
  };
  avatar: AvatarSettings;
  /** Whether a chatter may repin their own voice with a `[voice]` prefix. */
  allowChatterVoiceOverride: boolean;
  setupComplete: boolean;
}

/**
 * Everything the overlay paints, in one object — it is pushed to the overlay window whole
 * (see `AvatarMessage`), because that window has its own cached copy of the settings and a
 * localStorage write in the dashboard does not reach it.
 *
 * The three effects below are all **off by default**: the overlay's baseline behaviour is
 * the one the config screen has always described — idle image when quiet, frames cycling
 * while a message is read — and each of these is opt-in on top of it.
 */
export interface AvatarSettings {
  fps: number;
  hasIdle: boolean;
  frameCount: number;
  /**
   * What the overlay paints behind the avatar: an `#rrggbb` chroma-key colour, or the
   * literal `"transparent"`. Green screen is the default because OBS keys it out of the
   * box; transparency only survives a browser source, not a capture or a recording of one.
   */
  background: string;
  /**
   * Fade between the idle image and the talking frames instead of cutting. The fade is
   * between the two *states* only — frame-to-frame inside the talking cycle stays a hard
   * cut, because a fade longer than the frame hold (83 ms at 12 fps) would smear the mouth
   * into a permanent blur.
   */
  crossfade: { enabled: boolean; ms: number };
  /**
   * The line being spoken, drawn over the avatar. `x`/`y` are fractions of the overlay,
   * `size` is a percentage of its height so the caption scales with the browser source
   * rather than being pinned to one resolution.
   */
  caption: { enabled: boolean; x: number; y: number; size: number };
  /**
   * The bob: a rotation around the anchor and nothing else, imitating a head moving as it
   * talks. `anchorX`/`anchorY` are fractions of the overlay and become the avatar's
   * `transform-origin` — at the feet it rocks like a bobblehead, at the top it swings like
   * something hanging. It rests at `minAngle` and throws out to `angle`; `flip` mirrors both,
   * so the whole motion goes the other way rather than only half of it.
   *
   * `attackMs` (out to the angle) and `decayMs` (back to rest) are the shape, at speed ×1.
   * `speedMin`/`speedMax` are multipliers on that shape, re-rolled **on every bob** — a
   * fixed tempo reads as a metronome, which is the one thing a talking head never is.
   */
  bob: {
    enabled: boolean;
    anchorX: number;
    anchorY: number;
    angle: number;
    minAngle: number;
    flip: boolean;
    attackMs: number;
    decayMs: number;
    speedMin: number;
    speedMax: number;
  };
}

/** Chroma-key green. The colour every keying filter defaults to, so it needs no setup in OBS. */
export const DEFAULT_AVATAR_BACKGROUND = "#00FF00";

/** The one non-colour the background accepts — the old behaviour, kept as an explicit choice. */
export const TRANSPARENT_BACKGROUND = "transparent";

/**
 * Anything that is not `transparent` or a six-digit hex colour falls back to green rather
 * than reaching `style.background`, where a stored junk value would silently paint nothing
 * and read as a broken overlay.
 */
export function normalizeBackground(value: unknown): string {
  if (value === TRANSPARENT_BACKGROUND) return TRANSPARENT_BACKGROUND;
  if (typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value.trim())) {
    return value.trim().toUpperCase();
  }
  return DEFAULT_AVATAR_BACKGROUND;
}

/**
 * The gaps the segmented control offers, in milliseconds. Exported so the setup screen and
 * `normalize` agree: a stored value off this list (an older blob, or a hand-edited one) would
 * leave the control with no segment lit, so `normalize` snaps to the nearest option.
 */
export const MIN_DELAY_OPTIONS = [2000, 10000, 30000, 60000, 120000] as const;

/**
 * The bits threshold's range. The floor is 1, not 0: a cheer carries at least one bit, so 0
 * and 1 would mean the same thing while reading as "off". Exported so the setup screen's
 * stepper and `normalize` agree — a stored 0 is lifted to 1 on load.
 */
export const MIN_BITS_FLOOR = 1;
export const MIN_BITS_CEILING = 100000;

/**
 * The ranges the avatar-config sliders offer. Exported so the screen and `normalizeAvatar`
 * cannot drift apart — a stored value outside a range would leave a slider pinned to an end
 * it does not actually hold.
 */
export const CROSSFADE_MS_RANGE = [40, 2000] as const;
/** Caption size, as a percentage of the overlay's height. 5% is ~54 px on a 1080p source. */
export const CAPTION_SIZE_RANGE = [2, 14] as const;
/** How far the bob tips, in degrees. */
export const BOB_ANGLE_RANGE = [1, 45] as const;
/** Where it rests, in degrees — the other side of zero, so the swing can span it. */
export const BOB_MIN_ANGLE_RANGE = [-90, 0] as const;
/** One bob's shape at speed ×1, in milliseconds. */
export const BOB_ATTACK_RANGE = [40, 1500] as const;
export const BOB_DECAY_RANGE = [40, 3000] as const;
/** The multiplier rolled per bob. Higher is faster, so it divides the duration. */
export const BOB_SPEED_RANGE = [0.25, 3] as const;

function snapMinDelay(value: unknown): number {
  const ms = typeof value === "number" && Number.isFinite(value) ? value : MIN_DELAY_OPTIONS[0];
  return MIN_DELAY_OPTIONS.reduce((best, option) =>
    Math.abs(option - ms) < Math.abs(best - ms) ? option : best,
  );
}

export const DEFAULT_AVATAR: AvatarSettings = {
  fps: 12,
  hasIdle: false,
  frameCount: 0,
  background: DEFAULT_AVATAR_BACKGROUND,
  // All three effects off: the overlay's baseline is the plain idle/talking swap.
  crossfade: { enabled: false, ms: 250 },
  // Bottom centre, the one place a caption is expected — but it only appears once it is
  // switched on, so this is where the handle starts, not where anything is drawn.
  caption: { enabled: false, x: 0.5, y: 0.9, size: 5 },
  // Anchored at the bottom centre: the feet of an avatar that fills its frame, which is
  // the pivot a bob reads as natural around.
  bob: {
    enabled: false,
    anchorX: 0.5,
    anchorY: 1,
    angle: 30,
    // Rests at zero, so the bob is the single throw it was before this became a range.
    minAngle: 0,
    flip: false,
    // Decay is twice the attack: out fast, back at half speed.
    attackMs: 200,
    decayMs: 400,
    speedMin: 0.85,
    speedMax: 1.25,
  },
};

export const DEFAULT_SETTINGS: Settings = {
  auth: { channel: "", token: null, login: null, userId: null, scopes: [] },
  triggers: {
    // Off by default, as in the desktop app: reading every message in a busy chat drowns
    // out the cheers and redeems, which are the point.
    chat: false,
    cheers: { enabled: true, minBits: MIN_BITS_FLOOR },
    redeems: { enabled: true, rewardName: "Make Moneybot Speak" },
  },
  audio: {
    outputDeviceId: "default",
    playbackRate: 1.15,
    // Design replaces the desktop app's whole-second gap with a segmented control
    // (MIN_DELAY_OPTIONS), so this is milliseconds now.
    minDelayMs: 2000,
    masterVolume: 0.72,
  },
  avatar: DEFAULT_AVATAR,
  allowChatterVoiceOverride: true,
  setupComplete: false,
};

const KEY = "moneybot.settings.v1";

/** Clamps every numeric field to the range the design gives it. */
export function normalize(s: Settings): Settings {
  return {
    ...s,
    triggers: {
      ...s.triggers,
      cheers: {
        ...s.triggers.cheers,
        minBits: clampInt(s.triggers.cheers.minBits, MIN_BITS_FLOOR, MIN_BITS_CEILING),
      },
    },
    audio: {
      ...s.audio,
      playbackRate: clamp(s.audio.playbackRate, 0.5, 2),
      minDelayMs: snapMinDelay(s.audio.minDelayMs),
      masterVolume: clamp(s.audio.masterVolume, 0, 1),
    },
    avatar: normalizeAvatar(s.avatar),
  };
}

/**
 * Clamps the overlay's settings. Applied on the way *in* from storage and again on the way
 * into the overlay window, which receives them over BroadcastChannel — that is the one path
 * into the overlay that has not been through this store.
 */
export function normalizeAvatar(a: Partial<AvatarSettings> | undefined): AvatarSettings {
  const merged = {
    ...DEFAULT_AVATAR,
    ...a,
    crossfade: { ...DEFAULT_AVATAR.crossfade, ...a?.crossfade },
    caption: { ...DEFAULT_AVATAR.caption, ...a?.caption },
    bob: { ...DEFAULT_AVATAR.bob, ...a?.bob },
  };
  return {
    ...merged,
    fps: clampInt(merged.fps, 4, 24),
    background: normalizeBackground(merged.background),
    crossfade: {
      enabled: !!merged.crossfade.enabled,
      ms: clampInt(merged.crossfade.ms, ...CROSSFADE_MS_RANGE),
    },
    caption: {
      enabled: !!merged.caption.enabled,
      x: clamp(merged.caption.x, 0, 1),
      y: clamp(merged.caption.y, 0, 1),
      size: clamp(merged.caption.size, ...CAPTION_SIZE_RANGE),
    },
    bob: {
      enabled: !!merged.bob.enabled,
      anchorX: clamp(merged.bob.anchorX, 0, 1),
      anchorY: clamp(merged.bob.anchorY, 0, 1),
      angle: clamp(merged.bob.angle, ...BOB_ANGLE_RANGE),
      minAngle: clamp(merged.bob.minAngle, ...BOB_MIN_ANGLE_RANGE),
      flip: !!merged.bob.flip,
      attackMs: clampInt(merged.bob.attackMs, ...BOB_ATTACK_RANGE),
      decayMs: clampInt(merged.bob.decayMs, ...BOB_DECAY_RANGE),
      speedMin: clamp(merged.bob.speedMin, ...BOB_SPEED_RANGE),
      // Never below the floor: the two are separate sliders, and a range the wrong way round
      // would roll speeds outside both of them.
      speedMax: clamp(
        merged.bob.speedMax,
        clamp(merged.bob.speedMin, ...BOB_SPEED_RANGE),
        BOB_SPEED_RANGE[1],
      ),
    },
  };
}

export function clamp(n: number, lo: number, hi: number): number {
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo;
}
function clampInt(n: number, lo: number, hi: number): number {
  return Math.round(clamp(n, lo, hi));
}

function load(): Settings {
  if (typeof window === "undefined") return DEFAULT_SETTINGS;
  try {
    const raw = window.localStorage.getItem(KEY);
    // Always built fresh, even with nothing stored. useSyncExternalStore compares snapshots
    // by reference to decide whether the post-subscribe state differs from the hydration
    // render — returning the shared DEFAULT_SETTINGS object here would look like "no change"
    // and leave `isHydrated` stuck false for a first-time visitor.
    const parsed = (raw ? JSON.parse(raw) : {}) as Partial<Settings>;
    // Merged one level deep rather than spread flat: a settings blob written by an older
    // build is missing whole sub-objects, and a shallow spread would hand the app an
    // `audio` with no `masterVolume` rather than the default one.
    return normalize({
      auth: { ...DEFAULT_SETTINGS.auth, ...parsed.auth },
      triggers: {
        ...DEFAULT_SETTINGS.triggers,
        ...parsed.triggers,
        cheers: { ...DEFAULT_SETTINGS.triggers.cheers, ...parsed.triggers?.cheers },
        redeems: { ...DEFAULT_SETTINGS.triggers.redeems, ...parsed.triggers?.redeems },
      },
      audio: { ...DEFAULT_SETTINGS.audio, ...parsed.audio },
      // `normalizeAvatar` does its own one-level-deep merge, so a blob written before the
      // crossfade/caption/bob settings existed comes back with all three defaulted off.
      avatar: normalizeAvatar(parsed.avatar),
      allowChatterVoiceOverride:
        parsed.allowChatterVoiceOverride ?? DEFAULT_SETTINGS.allowChatterVoiceOverride,
      setupComplete: parsed.setupComplete ?? DEFAULT_SETTINGS.setupComplete,
    });
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
}

let current: Settings = DEFAULT_SETTINGS;
let hydrated = false;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

/**
 * Reads localStorage on first call and never again. Called from the store's subscribe path
 * rather than at module scope so the server render and the client's first render agree —
 * see `useSettings`.
 */
function ensureHydrated() {
  if (hydrated || typeof window === "undefined") return;
  current = load();
  hydrated = true;
}

export const settingsStore = {
  get(): Settings {
    ensureHydrated();
    return current;
  },
  /** The value React's server render and first client render both see. */
  getServerSnapshot(): Settings {
    return DEFAULT_SETTINGS;
  },
  set(update: Settings | ((prev: Settings) => Settings)) {
    ensureHydrated();
    const next = normalize(typeof update === "function" ? update(current) : update);
    current = next;
    try {
      window.localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      // A full or blocked store costs the user their preferences on the next visit; it
      // must not take down the setting they just changed.
    }
    emit();
  },
  subscribe(listener: () => void): () => void {
    ensureHydrated();
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  /** Whether localStorage has been read yet. False during SSR and the first paint. */
  isHydrated(): boolean {
    return hydrated;
  },
  clear() {
    try {
      window.localStorage.removeItem(KEY);
    } catch {
      /* nothing useful to do */
    }
    current = DEFAULT_SETTINGS;
    emit();
  },
};

/**
 * Settings, live. Returns DEFAULT_SETTINGS for the server render and the hydrating render,
 * then the real stored values — so anything that routes on `setupComplete` must wait for
 * `useSettingsReady()` rather than acting on the first value it sees.
 */
export function useSettings(): Settings {
  return useSyncExternalStore(
    settingsStore.subscribe,
    settingsStore.get,
    settingsStore.getServerSnapshot,
  );
}

/** False until localStorage has actually been read. Guards routing decisions. */
export function useSettingsReady(): boolean {
  return useSyncExternalStore(
    settingsStore.subscribe,
    () => settingsStore.isHydrated(),
    () => false,
  );
}

export function updateSettings(update: (prev: Settings) => Settings) {
  settingsStore.set(update);
}
