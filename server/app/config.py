"""Runtime settings, all overridable from the environment."""

from __future__ import annotations

import os
from dataclasses import dataclass


def _int(name: str, default: int) -> int:
    try:
        return int(os.environ[name])
    except (KeyError, ValueError):
        return default


def _float(name: str, default: float) -> float:
    try:
        return float(os.environ[name])
    except (KeyError, ValueError):
        return default


@dataclass(frozen=True)
class Settings:
    model_path: str = os.getenv("MODEL_PATH", "/models/kokoro-v1.0.onnx")
    voices_path: str = os.getenv("VOICES_PATH", "/models/voices-v1.0.bin")

    default_voice: str = os.getenv("DEFAULT_VOICE", "af_heart")
    default_lang: str = os.getenv("DEFAULT_LANG", "en-us")

    # Longest request we accept at all.
    max_text_chars: int = _int("MAX_TEXT_CHARS", 5000)

    # The first chunk is kept short so audio starts flowing quickly, then each
    # chunk grows by `chunk_growth` up to `chunk_chars`. The ramp matters: a
    # chunk that takes longer to synthesize than the client has buffered is an
    # audible gap. See engine.chunk_text.
    first_chunk_chars: int = _int("FIRST_CHUNK_CHARS", 60)
    chunk_chars: int = _int("CHUNK_CHARS", 320)
    chunk_growth: float = _float("CHUNK_GROWTH", 1.5)

    # How many finished chunks may sit in memory ahead of the client.
    prefetch: int = _int("PREFETCH", 2)

    # Synthesis threads. Also the cap on concurrent work across all requests.
    workers: int = _int("TTS_WORKERS", 2)

    # Synthesize a short phrase at startup so the first real request is not
    # the one paying for espeak/onnxruntime warmup.
    warmup: bool = os.getenv("WARMUP", "1") not in ("0", "false", "no")


settings = Settings()
