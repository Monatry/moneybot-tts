"use client";

/**
 * Remembers which voice every chatter speaks with. Port of the desktop `UserVoiceService`,
 * and the rule is unchanged: the streamer does not assign voices, because a voice is a
 * property of the *chatter*, not of the app. A name that has never been heard gets a random
 * voice rolled for it, keeps that voice forever, and only changes it by asking for another
 * one with a `[voice]` prefix.
 *
 * What the streamer *can* choose is which voices that roll draws from — `settings.randomVoices`,
 * threaded in as `chosen` below. It narrows the pool and nothing else: an assignment already
 * made is never revisited, so narrowing the pool does not re-roll the chatters who are
 * already speaking, and a chatter can still name any voice the engine has.
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

/**
 * The voices a new chatter may be rolled, given what the engine offers and what the
 * streamer picked on the setup screen.
 *
 * `chosen` is `settings.randomVoices`: an explicit pool, empty when the streamer has never
 * narrowed it. Empty therefore means "the default", not "nothing" — a genuinely empty pool
 * would mean nobody could ever be rolled a voice, so every step below widens rather than
 * gives up:
 *
 *   1. the streamer's pick, matched against the live list;
 *   2. every default-eligible voice — English, minus the blocked ones;
 *   3. everything not blocked, for a server serving no English at all;
 *   4. everything.
 *
 * An explicit pick is authoritative where the default is not. It may name a non-English
 * voice, and it may name a blocked one: `isDefaultEligible` exists to keep a voice nobody
 * asked for from being handed out unasked, and a checkbox on the setup screen *is* asking.
 *
 * Case comes from `available`, never from `chosen` or the store, so what reaches the engine
 * is always a string it actually published.
 */
export function randomPool(
  available: readonly string[],
  chosen: readonly string[] = [],
): string[] {
  if (chosen.length > 0) {
    const wanted = new Set(chosen.map((v) => v.toLowerCase()));
    // Filtering the live list rather than mapping over `chosen` also drops anything the
    // engine has retired, or never had: a pool picked on the 54-voice server build is
    // stored as-is and still works on the 28-voice browser one.
    const picked = available.filter((v) => wanted.has(v.toLowerCase()));
    if (picked.length > 0) return picked;
  }

  const english = available.filter(isDefaultEligible);
  if (english.length > 0) return english;

  const unblocked = available.filter((v) => !NEVER_ROLLED.has(v.toLowerCase()));
  return unblocked.length > 0 ? unblocked : [...available];
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
 * `chosen` only reaches the roll, never the lookup: a chatter who already has a voice keeps
 * it even once the streamer narrows the pool past it. Re-rolling them instead would change
 * the voice of everyone the pool dropped, which is the one thing this module promises never
 * to do.
 *
 * Returns null only when `available` is empty, i.e. the voice list never loaded. The empty
 * check comes first deliberately: without it a failed voice load would re-roll everyone on
 * every message.
 *
 * A chatter with an empty name (the setup and avatar test buttons) gets a voice but is
 * never stored, so a test cannot burn an entry on a name nobody chats under — and each
 * press rolls a fresh one.
 */
export function resolveVoiceFor(
  user: string,
  available: readonly string[],
  chosen: readonly string[] = [],
): string | null {
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

  const pool = randomPool(available, chosen);
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
