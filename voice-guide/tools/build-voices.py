#!/usr/bin/env python3
"""Regenerate public/voices.js from the sample renderer and the sample directory.

The page's card text is not hand-written: every voice's spoken line lives in
`LINES` in ../server/scripts/sample_voices.py, and the English translation of a
non-English line lives in the comment directly above it. Both are lifted from
there so the page cannot drift from the audio it is playing.

    tools/build-voices.py                 # rewrite public/voices.js
    tools/build-voices.py --check         # exit 1 if it is out of date

A voice is only emitted when public/samples/<id>.wav exists, so re-running
after copying in new samples is all it takes to add them.
"""

from __future__ import annotations

import argparse
import ast
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SOURCE = os.path.join(ROOT, "..", "server", "scripts", "sample_voices.py")
SAMPLES = os.path.join(ROOT, "public", "samples")
OUTPUT = os.path.join(ROOT, "public", "voices.js")

# First letter of the voice id → where the accent is from. Kokoro's own
# language codes (see LANGS in sample_voices.py); the country is the page's
# framing, since "categorised per country" is easier to browse than per
# language code.
# The page is written without em dashes, and two of the sample lines have one. They are
# rewritten here rather than in sample_voices.py: that file is the render script, and the
# wavs it produced are not being re-rendered. Nothing is lost by the split — Kokoro does not
# voice a dash, so the audio for these two is identical either way, and the replacements are
# the punctuation the sentence would have used instead (a colon for the appositive, commas
# for the aside).
#
# Keyed by voice id, matched against the original text so a rewrite that no longer applies
# is reported rather than silently ignored. `--check` fails on any em dash that gets past
# this, so a new sample line carrying one is caught the next time it runs.
DASHLESS: dict[str, tuple[str, str]] = {
    "af_alloy": (
        "I'll take the large. No, the large large — the one that comes in a bucket with a handle.",
        "I'll take the large. No, the large large: the one that comes in a bucket with a handle.",
    ),
    "af_river": (
        "Everything on this menu comes with fries, including the salad. And — I believe — the soup.",
        "Everything on this menu comes with fries, including the salad. And, I believe, the soup.",
    ),
}

COUNTRIES = [
    ("a", "United States", "\U0001f1fa\U0001f1f8", "American English"),
    ("b", "United Kingdom", "\U0001f1ec\U0001f1e7", "British English"),
    ("e", "Spain", "\U0001f1ea\U0001f1f8", "Spanish"),
    ("f", "France", "\U0001f1eb\U0001f1f7", "French"),
    ("i", "Italy", "\U0001f1ee\U0001f1f9", "Italian"),
    ("p", "Brazil", "\U0001f1e7\U0001f1f7", "Brazilian Portuguese"),
    ("h", "India", "\U0001f1ee\U0001f1f3", "Hindi"),
    ("j", "Japan", "\U0001f1ef\U0001f1f5", "Japanese"),
    ("z", "China", "\U0001f1e8\U0001f1f3", "Mandarin Chinese"),
]


def load_lines() -> dict[str, str]:
    """The LINES dict, read without importing the module (it pulls in the TTS client)."""
    tree = ast.parse(open(SOURCE, encoding="utf-8").read())
    for node in ast.walk(tree):
        if isinstance(node, ast.AnnAssign) and getattr(node.target, "id", "") == "LINES":
            return ast.literal_eval(node.value)
    raise SystemExit(f"no LINES dict in {SOURCE}")


def load_translations() -> dict[str, str]:
    """Translations from the comment block above each entry.

    Only comments that open with a quote are translations — section rules
    (`# -- a: American English ---`) and the note about kana are not, so a
    comment is ignored unless it opens the block with a quote. A translation
    may wrap over several lines; those continuations do get appended.
    """
    out: dict[str, str] = {}
    buffer: list[str] = []
    for raw in open(SOURCE, encoding="utf-8"):
        line = raw.strip()
        if line.startswith("#"):
            text = line.lstrip("#").strip()
            if buffer or text.startswith('"'):
                buffer.append(text)
            continue
        entry = re.match(r'^"([a-z]{2}_[a-z]+)"\s*:', line)
        if entry and buffer:
            text = " ".join(buffer).strip()
            if text.startswith('"') and text.endswith('"'):
                out[entry.group(1)] = text[1:-1]
        buffer = []
    return out


def dashless(voice: str, text: str) -> str:
    """The display text for `voice`, with any em dash rewritten. See DASHLESS."""
    rewrite = DASHLESS.get(voice)
    if not rewrite:
        return text
    original, replacement = rewrite
    if text != original:
        print(
            f"warning: the line for {voice} has changed; its DASHLESS rewrite no longer applies",
            file=sys.stderr,
        )
        return text
    return replacement


def build() -> str:
    lines = load_lines()
    translations = load_translations()
    have = {f[:-4] for f in os.listdir(SAMPLES) if f.endswith(".wav")}

    countries = []
    for code, country, flag, language in COUNTRIES:
        voices = []
        for voice in sorted(v for v in have if v.startswith(code)):
            entry = {
                "id": voice,
                # "af_sky" → "Sky". The bit after the underscore is the only
                # part that is a name; the prefix is language + gender.
                "name": voice.split("_", 1)[1].replace("_", " ").title(),
                "gender": "Female" if voice[1] == "f" else "Male",
                "line": dashless(voice, lines.get(voice, "")),
            }
            if voice in translations:
                entry["translation"] = translations[voice]
            voices.append(entry)
        if voices:
            countries.append(
                {"code": code, "country": country, "flag": flag, "language": language, "voices": voices}
            )

    missing = sorted(have - {v["id"] for c in countries for v in c["voices"]})
    if missing:
        print(f"warning: no country prefix for {', '.join(missing)}", file=sys.stderr)

    dashed = [
        v["id"]
        for c in countries
        for v in c["voices"]
        if "—" in v["line"] or "—" in v.get("translation", "")
    ]
    if dashed:
        raise SystemExit(
            f"em dash in the text for {', '.join(dashed)}; add a DASHLESS rewrite for it"
        )

    body = json.dumps(countries, ensure_ascii=False, indent=2)
    return (
        "/* Generated by tools/build-voices.py from ../server/scripts/sample_voices.py — do not edit. */\n"
        f"window.VOICE_CATALOGUE = {body};\n"
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="verify without writing")
    args = parser.parse_args()

    generated = build()
    if args.check:
        current = open(OUTPUT, encoding="utf-8").read() if os.path.exists(OUTPUT) else ""
        if current != generated:
            print(f"{OUTPUT} is out of date; re-run tools/build-voices.py", file=sys.stderr)
            return 1
        print(f"{OUTPUT} is up to date")
        return 0

    with open(OUTPUT, "w", encoding="utf-8") as fh:
        fh.write(generated)
    total = sum(len(c["voices"]) for c in json.loads(generated.split("=", 1)[1].rstrip().rstrip(";")))
    print(f"wrote {OUTPUT}: {total} voices")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
