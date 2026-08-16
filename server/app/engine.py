"""Speech synthesis, behind one small interface.

Everything the rest of the app knows about TTS lives here: load the model
once, then stream float32 chunks for a piece of text. Replacing Kokoro with
another engine means rewriting this module and nothing else.

The chunking is what makes the API feel immediate. Kokoro's own
`create_stream` batches by phoneme count (510 phonemes, ~30 s of speech), so
the first byte would take as long as a whole paragraph. Splitting the *text*
into sentences instead means the client hears sentence one while sentence two
is still being synthesized.
"""

from __future__ import annotations

import asyncio
import logging
import re
import time
from collections import deque
from collections.abc import AsyncIterator
from concurrent.futures import ThreadPoolExecutor

import numpy as np
from kokoro_onnx import Kokoro

log = logging.getLogger(__name__)

SAMPLE_RATE = 24000

# Sentence boundaries: terminal punctuation followed by space, or a blank line.
_SENTENCE_END = re.compile(r"(?<=[.!?;:…。！？])\s+|\n{2,}")


def _pack(words: list[str], limit: int) -> list[str]:
    """Greedily pack words into strings of at most `limit` characters."""
    out: list[str] = []
    buf = ""
    for word in words:
        if not buf:
            buf = word
        elif len(buf) + 1 + len(word) <= limit:
            buf = f"{buf} {word}"
        else:
            out.append(buf)
            buf = word
    if buf:
        out.append(buf)
    return out


def chunk_text(text: str, first_limit: int, limit: int, growth: float = 1.5) -> list[str]:
    """Split text into synthesis units of geometrically growing size.

    The first unit is short, so audio starts quickly. Each following unit is
    `growth` times larger, up to `limit`. The ramp is what keeps playback
    gapless: a chunk takes roughly half its own duration to synthesize, so as
    long as chunk n+1 is not much longer than what the client already has
    buffered, the buffer keeps growing and never runs dry. Jumping straight
    from a 60-character opener to a 320-character chunk does starve it.
    """
    sentences = [s.strip() for s in _SENTENCE_END.split(text) if s and s.strip()]
    if not sentences:
        return []

    pending = deque(sentences)
    chunks: list[str] = []
    buf = ""
    cap = max(1, min(first_limit, limit))

    while pending:
        unit = pending.popleft()
        if len(unit) > cap:
            # Too long for the current budget: break it on word boundaries
            # rather than hand it over whole, which would also risk the
            # model's 510-phoneme truncation.
            pieces = _pack(unit.split(), cap)
            if len(pieces) == 1 and len(unit) > limit:
                # One unbreakable token longer than a whole chunk (a URL, a
                # base64 blob): slice it, or the model silently drops
                # everything past its 510-phoneme ceiling.
                pieces = [unit[i : i + limit] for i in range(0, len(unit), limit)]
            if len(pieces) > 1:
                pending.extendleft(reversed(pieces))
                continue
        if not buf:
            buf = unit
        elif len(buf) + 1 + len(unit) <= cap:
            buf = f"{buf} {unit}"
        else:
            chunks.append(buf)
            buf = unit
            cap = min(limit, max(cap + 1, int(cap * growth)))
    if buf:
        chunks.append(buf)
    return chunks


class Engine:
    """A loaded Kokoro model plus the thread pool it runs on."""

    def __init__(self, model_path: str, voices_path: str, workers: int = 2):
        started = time.monotonic()
        self._kokoro = Kokoro(model_path, voices_path)
        self._voices = frozenset(self._kokoro.get_voices())
        # onnxruntime releases the GIL during inference, so threads are real
        # parallelism here. The pool size is also the global concurrency cap:
        # extra requests queue instead of thrashing the CPU.
        self._pool = ThreadPoolExecutor(max_workers=workers, thread_name_prefix="tts")
        log.info(
            "loaded %s (%d voices) in %.1fs",
            model_path,
            len(self._voices),
            time.monotonic() - started,
        )

    @property
    def voices(self) -> list[str]:
        return sorted(self._voices)

    def has_voice(self, name: str) -> bool:
        return name in self._voices

    def _synthesize(self, text: str, voice: str, speed: float, lang: str) -> np.ndarray:
        samples, _ = self._kokoro.create(text, voice=voice, speed=speed, lang=lang)
        return samples

    async def stream(
        self,
        text: str,
        *,
        voice: str,
        speed: float,
        lang: str,
        first_limit: int,
        limit: int,
        growth: float,
        prefetch: int,
    ) -> AsyncIterator[np.ndarray]:
        """Yield audio chunks as they finish, running one chunk ahead."""
        chunks = chunk_text(text, first_limit, limit, growth)
        if not chunks:
            return

        loop = asyncio.get_running_loop()
        queue: asyncio.Queue = asyncio.Queue(maxsize=max(1, prefetch))
        done = object()

        async def produce() -> None:
            try:
                for index, chunk in enumerate(chunks):
                    started = time.monotonic()
                    samples = await loop.run_in_executor(
                        self._pool, self._synthesize, chunk, voice, speed, lang
                    )
                    log.debug(
                        "chunk %d/%d: %d chars -> %.1fs audio in %.2fs",
                        index + 1,
                        len(chunks),
                        len(chunk),
                        len(samples) / SAMPLE_RATE,
                        time.monotonic() - started,
                    )
                    await queue.put(samples)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # surfaced to the consumer below
                await queue.put(exc)
            else:
                await queue.put(done)

        producer = asyncio.create_task(produce())
        try:
            while True:
                item = await queue.get()
                if item is done:
                    break
                if isinstance(item, BaseException):
                    raise item
                yield item
        finally:
            # Client hung up (or the loop raised): stop after the chunk that is
            # already in flight rather than synthesizing the rest for nobody.
            producer.cancel()

    def warmup(self, voice: str, lang: str) -> None:
        self._synthesize("Ready.", voice, 1.0, lang)

    def shutdown(self) -> None:
        self._pool.shutdown(wait=False, cancel_futures=True)
