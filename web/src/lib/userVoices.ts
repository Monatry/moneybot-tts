"use client";

/**
 * Remembers which voice every chatter speaks with. Port of the desktop `UserVoiceService`,
 * and the rule is unchanged: there is no streamer-facing voice picker, because the voice is
 * a property of the *chatter*, not of the app. A name that has never been heard gets a
 * random voice rolled for it, keeps that voice forever, and only changes it by asking for
 * another one with a `[voice]` prefix.
 *
 * Its own localStorage key, not part of `settings`: entries are written whenever a new
 * chatter first speaks, while settings are rewritten wholesale from every control on every
 * screen. Two keys mean neither write can clobber the other.
 */

const KEY = "moneybot.uservoices.v1";

let map: Record<string, string> | null = null;

function store(): Record<string, string> {
  if (map) return map;
  map = {};
  if (typeof window === "undefined") return map;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw) {
      const loaded = JSON.parse(raw) as Record<string, unknown>;
      for (const [user, voice] of Object.entries(loaded)) {
        if (user && typeof voice === "string" && voice) map[user.toLowerCase()] = voice;
      }
    }
  } catch {
    // A corrupt store is not worth failing a launch over — everyone just gets rolled a
    // fresh voice.
    map = {};
  }
  return map;
}

function save() {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(map ?? {}));
  } catch {
    // Losing the store costs everyone a re-roll; it must never take down the queue runner
    // that called this.
  }
}

/**
 * Voices never rolled for anyone, however eligible they otherwise look. Still reachable by a
 * chatter naming one in a `[voice]` prefix — this only takes them out of the random pool.
 */
const NEVER_ROLLED = new Set(["af_nicole"]);

/**
 * Whether a voice can be handed out at random. Kokoro prefixes every voice id with its
 * language — `a` is American English and `b` is British; everything else (`e` Spanish,
 * `f` French, `j` Japanese, `z` Mandarin, …) would be unintelligible handed out unasked,
 * and is reachable only by a chatter naming it.
 */
export function isDefaultEligible(voice: string): boolean {
  if (NEVER_ROLLED.has(voice.toLowerCase())) return false;
  const c = voice[0]?.toLowerCase();
  return c === "a" || c === "b";
}

export function getUserVoice(user: string): string | null {
  if (!user.trim()) return null;
  return store()[user.toLowerCase()] ?? null;
}

/** Pins a chatter to a voice — used when they pick one themselves. */
export function setUserVoice(user: string, voice: string) {
  if (!user.trim() || !voice) return;
  const s = store();
  const key = user.toLowerCase();
  if (s[key]?.toLowerCase() === voice.toLowerCase()) return; // unchanged — no rewrite
  s[key] = voice;
  save();
}

/**
 * The voice to read this chatter in, rolling and storing a new one when they are new — or
 * when the voice they were on no longer exists on the server, so a retired voice cannot
 * wedge one chatter into failing synthesis forever.
 *
 * Returns null only when `available` is empty, i.e. the voice list never loaded. The empty
 * check comes first deliberately: without it a failed voice load would re-roll everyone on
 * every message.
 *
 * A chatter with an empty name (the setup and avatar test buttons) gets a voice but is
 * never stored, so a test cannot burn an entry on a name nobody chats under — and each
 * press rolls a fresh one.
 */
export function resolveVoiceFor(user: string, available: readonly string[]): string | null {
  if (available.length === 0) return null;

  const named = user.trim().length > 0;
  const s = store();
  const key = user.toLowerCase();

  if (named) {
    const stored = s[key];
    if (stored) {
      // Matched against the live list so a retired voice is re-rolled rather than sent to
      // the server and rejected. Case comes from the list, not the store.
      const live = available.find((v) => v.toLowerCase() === stored.toLowerCase());
      if (live) return live;
    }
  }

  let pool = available.filter(isDefaultEligible);
  // Only if the server is serving nothing English at all — better an unexpected accent
  // than silence. Still not the blocked voices: that exclusion is absolute, and this
  // fallback would otherwise hand one out precisely when the pool is thinnest.
  if (pool.length === 0) pool = available.filter((v) => !NEVER_ROLLED.has(v.toLowerCase()));
  if (pool.length === 0) pool = [...available];

  const picked = pool[Math.floor(Math.random() * pool.length)];
  if (named) {
    s[key] = picked;
    save();
  }
  return picked;
}

export function knownVoiceCount(): number {
  return Object.keys(store()).length;
}
