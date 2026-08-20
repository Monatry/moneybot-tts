"use client";

import { useSyncExternalStore } from "react";
import { MAX_VOLUME } from "./audioPlayer";
import { DEFAULT_OBS_URL } from "./obsBridge";

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
  /** How the overlay is reached when it runs as an OBS browser source. */
  obs: ObsSettings;
  /** Browser engine only — ignored, but still stored, by a server-engine build. */
  localTts: LocalTtsSettings;
  /** Whether a chatter may repin their own voice with a `[voice]` prefix. */
  allowChatterVoiceOverride: boolean;
  /**
   * Which voices a chatter nobody has heard before may be rolled. Empty is the default and
   * means "every English voice"; see `randomPool` in lib/userVoices.ts for the whole ladder.
   *
   * A flat list of ids rather than anything structured, because that is all the engine
   * publishes and all the picker needs — and it is stored as picked, not as filtered
   * against the live list, so a pool chosen on the 54-voice server build survives being
   * loaded by the 28-voice browser one instead of being silently trimmed to it.
   */
  randomVoices: string[];
  setupComplete: boolean;
  /**
   * Which revision of this shape the stored blob was written by, so a value already in a
   * streamer's browser can be corrected once. See `SETTINGS_VERSION`.
   */
  version: number;
}

/**
 * How the in-browser Kokoro model runs. Only the browser engine reads these
 * (`NEXT_PUBLIC_TTS_ENGINE=browser`); a server-engine build keeps them untouched so that
 * switching builds does not lose the choice.
 *
 * Both default to `auto`, which the worker resolves as WebGPU at fp32 where the browser can
 * honour it and WASM at q8 everywhere else. The override exists because "can honour it" is
 * not something a feature test settles — a driver that accepts the adapter and then fails
 * to run the graph is common enough that a streamer needs to be able to say "just use the
 * CPU" and stop being surprised on stream. The worker falls back on its own too, but only
 * after paying for the discovery once per load.
 */
export interface LocalTtsSettings {
  device: "auto" | "wasm" | "webgpu";
  dtype: "auto" | "fp32" | "fp16" | "q8" | "q4" | "q4f16";
}

/**
 * The obs-websocket connection the overlay is pushed through when it runs inside OBS.
 *
 * Off by default: the overlay in a browser window needs none of this, and a bridge that
 * dialled a local port unasked would be a connection attempt nobody requested.
 *
 * The password is stored in plaintext next to the Twitch token, and for the same reason —
 * localStorage is all a browser offers. It is worth less than the token: it authorises
 * control of an OBS running on this machine, by something already running on this machine.
 */
export interface ObsSettings {
  enabled: boolean;
  url: string;
  password: string;
}

export const DEFAULT_OBS: ObsSettings = { enabled: false, url: DEFAULT_OBS_URL, password: "" };

/**
 * A URL the browser will actually dial. Anything that is not `ws://` or `wss://` falls back
 * to the default rather than reaching `new WebSocket`, where it throws synchronously.
 *
 * Note what is *not* enforced: a non-loopback host. It is very nearly always wrong — a plain
 * `ws://` to anywhere else is blocked as mixed content on an https page, and OBS binds
 * loopback by default — but someone deliberately reaching a `wss://` OBS on another machine
 * is a legitimate setup, and the connection error says so clearly enough.
 */
function normalizeObs(value: Partial<ObsSettings> | undefined): ObsSettings {
  const url = (value?.url ?? "").trim();
  return {
    enabled: !!value?.enabled,
    url: /^wss?:\/\/.+/i.test(url) ? url : DEFAULT_OBS.url,
    password: typeof value?.password === "string" ? value.password : "",
  };
}

/**
 * The random-voice pool, cleaned: lower-cased, de-duplicated and sorted, so two stores that
 * hold the same pool hold the same string and a `[]` written by an older build (or by hand)
 * cannot reach `randomPool` as something other than an array of ids.
 *
 * Order is thrown away deliberately — the pool is a set, the picker renders it grouped by
 * language, and a stable order keeps the settings blob from churning on every toggle.
 */
function normalizeRandomVoices(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const id = entry.trim().toLowerCase();
    if (id) ids.add(id);
  }
  return [...ids].sort();
}

export const LOCAL_TTS_DEVICES = ["auto", "wasm", "webgpu"] as const;
export const LOCAL_TTS_DTYPES = ["auto", "fp32", "fp16", "q8", "q4", "q4f16"] as const;

export const DEFAULT_LOCAL_TTS: LocalTtsSettings = { device: "auto", dtype: "auto" };

/** Anything not on the list falls back to `auto` rather than reaching the worker, where an
 *  unknown dtype is a download of a file the hub does not have. */
function normalizeLocalTts(value: Partial<LocalTtsSettings> | undefined): LocalTtsSettings {
  const device = LOCAL_TTS_DEVICES.includes(value?.device as never)
    ? (value!.device as LocalTtsSettings["device"])
    : DEFAULT_LOCAL_TTS.device;
  const dtype = LOCAL_TTS_DTYPES.includes(value?.dtype as never)
    ? (value!.dtype as LocalTtsSettings["dtype"])
    : DEFAULT_LOCAL_TTS.dtype;
  return { device, dtype };
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

/**
 * The current revision of the stored settings blob.
 *
 * Bumped only when a value *already in a streamer's browser* has to be corrected. A new
 * field needs nothing here — the one-level-deep merge in `load` defaults it on its own.
 * This is for the other case, where the stored value is valid, was never chosen by anyone,
 * and would otherwise outlive the decision that produced it.
 *
 * - **1 → 2: master volume forced back to the default.** It shipped at 0.72, and the one
 *   control that changes it (the dashboard's slider) is a thing a streamer has to notice
 *   and think to drag — so in practice every existing store holds a quiet value nobody
 *   chose. Raising the default alone would have helped only installs that do not exist yet;
 *   the migration is what reaches the stores already out there.
 */
export const SETTINGS_VERSION = 2;

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
    // Full scale. Anything below it is quieter than the audio the model produced, and the
    // dashboard's slider is there for a streamer who wants it quieter — see the 1 → 2
    // migration in `load` for the stores that were left on the old 0.72 default.
    masterVolume: 1,
  },
  avatar: DEFAULT_AVATAR,
  obs: DEFAULT_OBS,
  localTts: DEFAULT_LOCAL_TTS,
  allowChatterVoiceOverride: true,
  // Empty, i.e. the default English pool. Not the eligible list spelled out: a stored list
  // would freeze today's voices in, and a voice the engine gains later would never be rolled
  // for anyone who set up before it existed.
  randomVoices: [],
  setupComplete: false,
  version: SETTINGS_VERSION,
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
      masterVolume: clamp(s.audio.masterVolume, 0, MAX_VOLUME),
    },
    avatar: normalizeAvatar(s.avatar),
    obs: normalizeObs(s.obs),
    localTts: normalizeLocalTts(s.localTts),
    randomVoices: normalizeRandomVoices(s.randomVoices),
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
    const stored = raw ? (JSON.parse(raw) as Partial<Settings>) : null;
    const parsed = stored ?? {};
    // A blob with no `version` was written before the field existed, i.e. 1. *Nothing*
    // stored is a first visit, which starts at the current version — there is no older
    // value there to correct, and treating it as version 1 would run every future
    // migration against the defaults for no reason.
    const version = stored
      ? typeof stored.version === "number"
        ? stored.version
        : 1
      : SETTINGS_VERSION;
    const audio = { ...DEFAULT_SETTINGS.audio, ...parsed.audio };
    // The 1 → 2 correction. Assigned rather than merged, because the point is to overwrite
    // a value that *is* present in the stored blob.
    if (version < 2) audio.masterVolume = DEFAULT_SETTINGS.audio.masterVolume;
    // Merged one level deep rather than spread flat: a settings blob written by an older
    // build is missing whole sub-objects, and a shallow spread would hand the app an
    // `audio` with no `masterVolume` rather than the default one.
    const migrated = normalize({
      auth: { ...DEFAULT_SETTINGS.auth, ...parsed.auth },
      triggers: {
        ...DEFAULT_SETTINGS.triggers,
        ...parsed.triggers,
        cheers: { ...DEFAULT_SETTINGS.triggers.cheers, ...parsed.triggers?.cheers },
        redeems: { ...DEFAULT_SETTINGS.triggers.redeems, ...parsed.triggers?.redeems },
      },
      audio,
      // `normalizeAvatar` does its own one-level-deep merge, so a blob written before the
      // crossfade/caption/bob settings existed comes back with all three defaulted off.
      avatar: normalizeAvatar(parsed.avatar),
      obs: normalizeObs(parsed.obs),
      localTts: normalizeLocalTts(parsed.localTts),
      allowChatterVoiceOverride:
        parsed.allowChatterVoiceOverride ?? DEFAULT_SETTINGS.allowChatterVoiceOverride,
      // `normalize` cleans it too; naming it here is what keeps a blob written before the
      // pool existed from arriving as `undefined`.
      randomVoices: normalizeRandomVoices(parsed.randomVoices),
      setupComplete: parsed.setupComplete ?? DEFAULT_SETTINGS.setupComplete,
      version: SETTINGS_VERSION,
    });
    // Written back so a migration is the one-time event it reads as. Skipping this would
    // still be correct — every migration above is idempotent — but the blob would keep
    // claiming version 1 until something else happened to save it, and the next migration
    // author would be reasoning about a store that never moves forward.
    if (version < SETTINGS_VERSION) persist(migrated);
    return migrated;
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
}

/**
 * The only writer of the settings key. A full or blocked store costs the user their
 * preferences on the next visit; it must not take down the setting they just changed.
 */
function persist(s: Settings) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* nothing useful to do */
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
    persist(next);
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
