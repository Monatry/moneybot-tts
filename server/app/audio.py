"""Turning float32 sample arrays into bytes on the wire.

Kokoro hands back mono float32 at 24 kHz. Clients get signed 16-bit
little-endian PCM, either raw or inside a WAV container.
"""

from __future__ import annotations

import struct

import numpy as np

# A streaming WAV cannot know its own length up front, so the two size fields
# are written as "unknown". Players read until the connection closes.
UNKNOWN_SIZE = 0xFFFFFFFF


def wav_header(sample_rate: int, channels: int = 1, bits: int = 16) -> bytes:
    """A 44-byte RIFF/WAVE header for a stream of undeclared length."""
    block_align = channels * bits // 8
    return b"".join(
        (
            b"RIFF",
            struct.pack("<I", UNKNOWN_SIZE),
            b"WAVEfmt ",
            struct.pack(
                "<IHHIIHH",
                16,  # fmt chunk size
                1,  # PCM
                channels,
                sample_rate,
                sample_rate * block_align,  # byte rate
                block_align,
                bits,
            ),
            b"data",
            struct.pack("<I", UNKNOWN_SIZE),
        )
    )


def to_pcm16(samples: np.ndarray) -> bytes:
    """Clip to [-1, 1] and quantize to s16le."""
    clipped = np.clip(samples, -1.0, 1.0)
    return (clipped * 32767.0).astype("<i2").tobytes()
