/**
 * Turns a raw Twitch message into something worth speaking. Port of the desktop app's
 * `ChatText.Clean`, and load-bearing for the same two reasons it was there:
 *
 * Kokoro reads characters it has no pronunciation for by *describing* them, so an emoji in
 * chat comes out as a spoken symbol name tacked onto the message. Measured against the
 * server: "hello there" is 0.98s of audio, "hello there\u{1F600}" is 2.01s — the emoji alone
 * is a second of speech nobody asked for. Invisible characters (zero-width spaces, the tag
 * characters some clients append to dodge Twitch's duplicate-message filter) cost no audio
 * but do break the [voice] prefix match, so they go too.
 *
 * Every message is cleaned at the point it enters the app — in the IRC and EventSub
 * handlers — never later, because the [voice] prefix is matched after this runs.
 */

/*
 * The .NET original switched on UnicodeCategory. JS regex property escapes are the direct
 * equivalent:
 *   \p{So} OtherSymbol      — emoji, ◆, ❤, ™
 *   \p{Sk} ModifierSymbol   — skin-tone modifiers, spacing accents
 *   \p{Cc} Control, \p{Cf} Format, \p{Cs} Surrogate, \p{Co} PrivateUse, \p{Cn} Unassigned
 *
 * Currency and math symbols are deliberately absent — "$5" and "2 + 2" read correctly.
 */
const NARRATED = /[\p{So}\p{Sk}\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}]/u;

/**
 * Invisible characters Unicode files under NonSpacingMark, alongside ordinary accents.
 * Variation selectors are the common case — the "️" in "❤️" is one, and it outlives
 * the heart it was modifying unless it is named explicitly. A category-only filter either
 * keeps them or eats the accent in "café"; neither is right.
 */
function isInvisibleMark(cp: number): boolean {
  return (
    (cp >= 0xfe00 && cp <= 0xfe0f) || // variation selectors
    (cp >= 0xe0100 && cp <= 0xe01ef) || // variation selectors supplement
    cp === 0x034f // combining grapheme joiner
  );
}

/**
 * Strips characters the voice would narrate rather than pronounce, and normalises the
 * whitespace left behind. Returns "" when nothing speakable remains — an emoji-only message
 * is not worth a request.
 */
export function cleanChatText(input: string | null | undefined): string {
  if (!input) return "";

  let out = "";
  // Iterating the string yields code points, not UTF-16 units: an emoji is a surrogate
  // pair, and walking units would leave half of one behind.
  for (const ch of input) {
    const cp = ch.codePointAt(0)!;
    // Checked ahead of the category test: these are NonSpacingMark, the same category as
    // the accent on "café", so the categories cannot tell them apart.
    if (isInvisibleMark(cp) || NARRATED.test(ch)) {
      // A space, so "good😀morning" does not fuse into one nonsense word.
      out += " ";
      continue;
    }
    out += ch;
  }

  return out.replace(/\s+/g, " ").trim();
}

/** `[af_sky] hello` → `{ voice: "af_sky", text: "hello" }`. Null when there is no prefix. */
const VOICE_PREFIX = /^\[([a-zA-Z0-9_]+)\]\s*(.+)$/;

export function splitVoicePrefix(text: string): { voice: string; text: string } | null {
  const m = VOICE_PREFIX.exec(text);
  return m ? { voice: m[1], text: m[2] } : null;
}
