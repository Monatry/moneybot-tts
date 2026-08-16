#!/usr/bin/env python3
"""Render one sample .wav per voice, so you can hear them all back to back.

Every voice gets its own line, configured in LINES below — edit that and
re-run. Each line is written in the voice's own language and leans on the
laziest possible national cliché, because a voice is much easier to tell apart
when it is saying something ridiculous.

    scripts/sample_voices.py                      # all 54, into samples/
    scripts/sample_voices.py --list               # what would be said, no audio
    scripts/sample_voices.py -v 'b*' -v af_heart  # only some
    scripts/sample_voices.py --force -o /tmp/out  # re-render, elsewhere

Existing files are skipped, so an interrupted run resumes where it stopped.
"""

from __future__ import annotations

import argparse
import contextlib
import fnmatch
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "client"))

from tts_client import DEFAULT_URL, TTSClient, TTSError  # noqa: E402

# --------------------------------------------------------------------------
# What each voice says. Voice ids come from GET /voices; the first letter is
# the language and the second the gender (af_ = American female, bm_ = British
# male, and so on).
# --------------------------------------------------------------------------

LINES: dict[str, str] = {
    # -- a: American English -----------------------------------------------
    "af_alloy": "I'll take the large. No, the large large — the one that comes in a bucket with a handle.",
    "af_aoede": "Sure, it's a twelve hour drive, but that's basically next door. I just need to grab an iced coffee first.",
    "af_bella": "This ranch dressing? I brought it from home. You never know.",
    "af_heart": "Good morning! I am contractually required to ask how you're doing, and I am sincerely thrilled to hear it.",
    "af_jessica": "My health insurance covers exactly one of my two kidneys. Provided I can afford the deductible.",
    "af_kore": "We put ice in everything here. Water, soda, tea. But most importantly: Opinions.",
    "af_nicole": "I'd love to chat, but only I have twenty minutes of vacation left for the entire year.",
    "af_nova": "It's a cheesecake, so why shouldn't I add cheese on top?",
    "af_river": "Everything on this menu comes with fries, including the salad. And — I believe — the soup.",
    "af_sarah": "Can I please take my coffee to go in my Stanley Cup?",
    "af_sky": "The recipe called for one stick of butter, so I used four. That's just math.",
    "am_adam": "I don't need the metric system. I measure distance in football fields and time in seasons of television.",
    "am_echo": "Sir, this is a Wendy's.",
    "am_eric": "I bought a truck so big it has its own weather. I use it to carry one bag of mulch, twice a year.",
    "am_fenrir": "The grill is not a cooking appliance. The grill is a personality.",
    "am_liam": "I tipped the guy who handed me a bottle of water 20%. That's 40 dollars tip.",
    "am_michael": "Welcome to the store! Ask me about our extended warranty on the warranty.",
    "am_onyx": "In this country the eagle screams, the flag waves, and somebody, somewhere, is deep frying a turkey.",
    "am_puck": "I ordered the small portion and they wheeled it out.",
    "am_santa": "Ho ho ho! Leave out the cookies, and if you have a soda the size of a fire hydrant, leave that too.",
    # -- b: British English ------------------------------------------------
    "bf_alice": "There's nothing a plate of beans on toast can't fix. Nothing worth fixing, at any rate.",
    "bf_emma": "I'm terribly sorry. You stepped on my foot, and I apologise for having a foot there in the first place.",
    "bf_isabella": "It's fourteen degrees and the sun is out, so the shirts are off and the entire nation is in a beer garden.",
    "bf_lily": "I have queued for forty minutes and I'd like it on record that I am enjoying myself enormously.",
    "bm_daniel": "Oy bruv. Are you having a laugh? I'll smack you with my bottle of water.",
    "bm_fable": "Aweful weather, isn't it? I say that every day, and every day it is awful.",
    "bm_george": "The correct answer is a cup of tea. No matter the question.",
    "bm_lewis": "Warm beer, cold house, and a full English breakfast at two in the afternoon.",
    # -- e: Spanish --------------------------------------------------------
    # "Eight in the evening? Great, then we'll have dinner at half eleven."
    "ef_dora": "¿Las ocho de la tarde? Buenísimo, entonces cenamos a las once y media.",
    # "We'll do it tomorrow. And if tomorrow doesn't work, the day after also exists."
    "em_alex": "Lo hacemos mañana. Y si mañana no puede ser, pues pasado mañana también existe.",
    # "Ho ho ho! Leave me some ham and a bit of nougat, the carols are long."
    "em_santa": "¡Jo, jo, jo! Dejadme jamón y un poquito de turrón, que los villancicos son muy largos.",
    # -- f: French ---------------------------------------------------------
    # "There's a strike on, the bread is still warm, and the cheese smells very
    #  strong indeed. In short, a perfect day."
    "ff_siwis": "Il y a une grève, le pain est encore chaud, et le fromage sent très, très fort. Bref, une journée parfaite.",
    # -- h: Hindi ----------------------------------------------------------
    # "Nothing starts without chai. First the tea, then the rest of the world."
    "hf_alpha": "चाय के बिना कोई बात शुरू नहीं होती। पहले चाय, फिर बाकी दुनिया।",
    # "We're arriving in just five minutes. Meaning we haven't left, but we're arriving."
    "hf_beta": "बस पाँच मिनट में पहुँच रहे हैं। मतलब अभी निकले भी नहीं हैं, लेकिन पहुँच रहे हैं।",
    # "This food is a little short on chilli. Fine for you, sweet for us."
    "hm_omega": "खाने में मिर्च थोड़ी कम है। तुम्हारे लिए ठीक है, हमारे लिए तो मीठा है।",
    # "The cricket match is on, so the office, the traffic and the wedding can all wait."
    "hm_psi": "क्रिकेट मैच चल रहा है, तो ऑफिस, ट्रैफिक और शादी, सब इंतज़ार कर सकते हैं।",
    # -- i: Italian --------------------------------------------------------
    # "Pineapple on pizza? No. And a cappuccino after lunch? Worse. I'm calling my grandmother."
    "if_sara": "L'ananas sulla pizza? No. E il cappuccino dopo pranzo? Ancora peggio. Adesso chiamo mia nonna.",
    # "If I put my hands in my pockets I can't speak any more. Pasta is drained al dente, full stop."
    "im_nicola": "Se metto le mani in tasca non riesco più a parlare. La pasta si scola al dente, punto.",
    # -- j: Japanese -------------------------------------------------------
    # Written in kana, deliberately. espeak has no kanji dictionary, so a line
    # with kanji in it is read a character at a time and takes five times as
    # long — 電車が二十秒遅れました was 24 seconds of audio for one sentence, and
    # long enough to trip Kokoro's 510-phoneme ceiling. Kana is read as speech.
    # Spaces stand in for the word boundaries kanji would normally mark.
    # "Sorry, sorry. Nothing is wrong, but, for now, sorry."
    "jf_alpha": "すみません、すみません。なにも わるくないですけど、とりあえず、すみません。",
    # "The train was twenty seconds late. The conductor apologised ten times."
    "jf_gongitsune": "でんしゃが にじゅうびょう おくれました。しゃしょうさんが じゅっかい あやまりました。",
    # "A convenience store rice ball is breakfast, lunch and dinner."
    "jf_nezumi": "コンビニのおにぎりは、あさごはんで、ひるごはんで、ばんごはんです。",
    # "There are far too many vending machines. There is probably even a vending
    #  machine that sells vending machines."
    "jf_tebukuro": "じどうはんばいきが おおすぎます。じどうはんばいきを うる じどうはんばいきも、たぶん あります。",
    # "Overtime again today. I'll take the last train home and buy a new KitKat flavour on the way."
    "jm_kumo": "きょうも ざんぎょうです。しゅうでんで かえって、コンビニで あたらしい あじの キットカットを かいます。",
    # -- p: Brazilian Portuguese -------------------------------------------
    # "I'm on my way out! That is, I'm still in the shower, but I'm on my way out."
    "pf_dora": "Já estou saindo! Ou seja, ainda estou no banho, mas já estou saindo.",
    # "For a barbecue we agree on noon, arrive at three, and eat until next Sunday."
    "pm_alex": "No churrasco a gente combina meio-dia, chega às três, e come até domingo que vem.",
    # "Ho ho ho! Father Christmas in shorts and flip flops, because here Christmas is forty degrees."
    "pm_santa": "Ho ho ho! Papai Noel de bermuda e chinelo, porque aqui o Natal tem quarenta graus.",
    # -- z: Mandarin Chinese -----------------------------------------------
    # "Have you eaten? If not, drink some hot water first, then we'll go for hotpot."
    "zf_xiaobei": "吃了吗？没吃的话，先喝点热水，然后我们去吃火锅。",
    # "Drink more hot water. Got a cold? Hot water. Feeling sad? Also hot water."
    "zf_xiaoni": "多喝热水。感冒了喝热水，心情不好也喝热水。",
    # "I leave the house with only my phone. My wallet has been lying at home for three years."
    "zf_xiaoxiao": "我出门只带手机，钱包在家躺着，已经三年没用过了。",
    # "I can save three yuan on this with a group order. I've already started five chat groups."
    "zf_xiaoyi": "这个拼单能便宜三块钱，我已经拉了五个群了。",
    # "Mahjong is not a game. It is our family's traditional sport."
    "zm_yunjian": "麻将不是游戏，是我们家的传统体育项目。",
    # "My mother asked when I'm getting married. I said, right after I finish this meal."
    "zm_yunxi": "我妈问我什么时候结婚，我说等我吃完这顿饭再说。",
    # "Goji berries steeping in the thermos. Healthy living starts today, or tomorrow."
    "zm_yunxia": "保温杯里泡枸杞，养生从今天开始，或者明天。",
    # "The delivery arrived in twenty minutes. It took me forty to decide what to order."
    "zm_yunyang": "外卖二十分钟就送到了，我却花了四十分钟才决定吃什么。",
}

# The voice id's first letter picks the espeak language used to phonemize the
# text. Getting this wrong is not an error, just a very strong accent: an
# Italian line read as en-us comes out as a tourist reading a menu.
#
# Mandarin is `cmn`, not `zh` — espeak does not know `zh` and the request comes
# back a valid, entirely silent wav.
LANGS: dict[str, str] = {
    "a": "en-us",
    "b": "en-gb",
    "e": "es",
    "f": "fr-fr",
    "h": "hi",
    "i": "it",
    "j": "ja",
    "p": "pt-br",
    "z": "cmn",
}

# Used for a voice the server offers but LINES has no entry for (a new voice in
# a model update, say) — it still gets a sample, just a boring one.
FALLBACK_LINE = "This voice has no sample line configured yet, so it is reading the label off the tin."

SPEED = 1.0

# --------------------------------------------------------------------------


def lang_for(voice: str) -> str:
    return LANGS.get(voice[:1], "en-us")


def line_for(voice: str) -> tuple[str, bool]:
    """The configured line, plus whether it had to fall back."""
    line = LINES.get(voice)
    return (line, False) if line else (FALLBACK_LINE, True)


def select(voices: list[str], patterns: list[str]) -> list[str]:
    """Filter server voices by glob (`b*`, `*santa`) or exact id."""
    if not patterns:
        return voices
    chosen = [v for v in voices if any(fnmatch.fnmatch(v, p) for p in patterns)]
    if not chosen:
        raise SystemExit(f"no voice matches {', '.join(patterns)}")
    return chosen


def render(client: TTSClient, voice: str, out_dir: str, force: bool) -> tuple[str, str]:
    """Write one sample. Returns (voice, status) for the summary."""
    path = os.path.join(out_dir, f"{voice}.wav")
    if os.path.exists(path) and not force:
        print(f"  {voice:<14} skipped (exists)")
        return voice, "skipped"

    text, fell_back = line_for(voice)
    started = time.monotonic()
    try:
        # Write to a temporary name so an interrupted run does not leave a
        # truncated wav that the next run would happily skip.
        partial = f"{path}.partial"
        client.save(text, partial, voice=voice, speed=SPEED, lang=lang_for(voice))
        os.replace(partial, path)
    except Exception as exc:
        # Broad on purpose: a chunk that fails mid-synthesis cuts the stream
        # rather than returning a status, which surfaces here as whatever the
        # HTTP layer makes of a truncated chunked body. One bad voice should
        # not end the run.
        print(f"  {voice:<14} FAILED: {type(exc).__name__}: {exc}")
        with contextlib.suppress(OSError):
            os.remove(partial)
        return voice, "failed"

    note = "  (no line configured)" if fell_back else ""
    size = os.path.getsize(path)
    seconds = (size - 44) / (24000 * 2)
    print(f"  {voice:<14} {seconds:5.1f}s audio in {time.monotonic() - started:5.1f}s{note}")
    return voice, "written"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("-u", "--url", default=DEFAULT_URL, help=f"API base URL (default {DEFAULT_URL})")
    parser.add_argument("-o", "--out", default="samples", help="output directory (default samples/)")
    parser.add_argument("-v", "--voice", action="append", default=[], metavar="GLOB",
                        help="only voices matching this; repeatable")
    parser.add_argument("-f", "--force", action="store_true", help="re-render files that already exist")
    # Serial by default, and not out of politeness: phonemizer's espeak backend
    # is a process-wide cached object, so two requests phonemizing at once
    # intermittently kill each other ("number of lines in input and output must
    # be equal") and one of them ends up with a header and no audio. Raise this
    # only if that ever gets fixed server-side.
    parser.add_argument("-j", "--jobs", type=int, default=1,
                        help="parallel requests (default 1; see the note in the source before raising it)")
    parser.add_argument("--list", action="store_true", help="print voice, language and line; write nothing")
    args = parser.parse_args(argv)

    client = TTSClient(args.url)
    try:
        available = client.voices()
    except TTSError as exc:
        print(f"cannot reach {args.url}: {exc}", file=sys.stderr)
        return 1

    voices = select(available, args.voice)

    if args.list:
        for voice in voices:
            text, fell_back = line_for(voice)
            mark = "*" if fell_back else " "
            print(f"{mark}{voice:<14} {lang_for(voice):<6} {text}")
        return 0

    missing = sorted(set(LINES) - set(available))
    if missing:
        print(f"configured but not on the server: {', '.join(missing)}", file=sys.stderr)

    os.makedirs(args.out, exist_ok=True)
    print(f"{len(voices)} voices -> {args.out}/")

    started = time.monotonic()
    with ThreadPoolExecutor(max_workers=max(1, args.jobs)) as pool:
        results = list(pool.map(lambda v: render(client, v, args.out, args.force), voices))

    counts: dict[str, int] = {}
    for _, status in results:
        counts[status] = counts.get(status, 0) + 1
    summary = ", ".join(f"{n} {status}" for status, n in sorted(counts.items()))
    print(f"{summary} in {time.monotonic() - started:.1f}s")
    return 1 if counts.get("failed") else 0


if __name__ == "__main__":
    raise SystemExit(main())
