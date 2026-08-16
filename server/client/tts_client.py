#!/usr/bin/env python3
"""A small client for the Kokoro TTS API. Standard library only.

As a library:

    from tts_client import TTSClient

    tts = TTSClient("https://tts.example.com/tts")   # any host; defaults to localhost:8020
    tts.save("Good morning.", "hello.wav")          # write a file
    tts.play("Streaming straight to the speakers.")  # play as it arrives
    for pcm in tts.stream("Chunk by chunk."):        # do your own thing
        ...

From the shell:

    ./tts_client.py --voices
    ./tts_client.py "Good morning." -o hello.wav
    ./tts_client.py "Read this out loud." --play --voice am_michael --speed 1.1
"""

from __future__ import annotations

import argparse
import contextlib
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import wave
from collections.abc import Iterator

DEFAULT_URL = "http://localhost:8020"

# The server always speaks mono signed 16-bit little-endian at 24 kHz, and
# repeats it in the X-Sample-Rate / X-Audio-Format / X-Channels headers.
SAMPLE_RATE = 24000
CHANNELS = 1
SAMPLE_WIDTH = 2

# Players that can take raw PCM on stdin, best first. Playing while receiving
# is the whole point: waiting for the full file would throw away the streaming.
PLAYERS = (
    ("ffplay", ["-autoexit", "-nodisp", "-loglevel", "quiet",
                "-f", "s16le", "-ar", str(SAMPLE_RATE), "-ac", str(CHANNELS), "-i", "-"]),
    ("aplay", ["-q", "-f", "S16_LE", "-r", str(SAMPLE_RATE), "-c", str(CHANNELS)]),
    ("paplay", ["--raw", "--format=s16le", f"--rate={SAMPLE_RATE}", f"--channels={CHANNELS}"]),
)


class TTSError(RuntimeError):
    """The server rejected the request, or could not be reached."""


class TTSClient:
    def __init__(self, base_url: str = DEFAULT_URL, timeout: float = 600.0):
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout

        # Cloudflare blocks the default "Python-urllib/x.y" agent outright
        # (error 1010), so the public URL needs a name of our own.
        self.headers = {"user-agent": "tts-client/1.0"}

        # A deployment behind Cloudflare Access (as the author's is) answers a
        # browser answers by logging in. A script needs a service token:
        # create one in Zero Trust > Access > Service Auth and export these.
        client_id = os.getenv("CF_ACCESS_CLIENT_ID")
        client_secret = os.getenv("CF_ACCESS_CLIENT_SECRET")
        if client_id and client_secret:
            self.headers["CF-Access-Client-Id"] = client_id
            self.headers["CF-Access-Client-Secret"] = client_secret

    # -- plumbing ---------------------------------------------------------

    def _open(self, path: str, payload: dict | None = None):
        url = f"{self.base_url}{path}"
        data = None
        headers = dict(self.headers)
        if payload is not None:
            data = json.dumps(payload).encode()
            headers["content-type"] = "application/json"
        request = urllib.request.Request(url, data=data, headers=headers)
        try:
            return urllib.request.urlopen(request, timeout=self.timeout)
        except urllib.error.HTTPError as exc:
            # Validation failures arrive before any audio does, so the body is
            # still JSON and worth showing.
            detail = exc.read().decode("utf-8", "replace")
            with contextlib.suppress(json.JSONDecodeError):
                detail = json.loads(detail).get("detail", detail)
            raise TTSError(f"{exc.code} {exc.reason}: {detail}") from None
        except urllib.error.URLError as exc:
            raise TTSError(f"cannot reach {url}: {exc.reason}") from None

    def _get_json(self, path: str) -> dict:
        with self._open(path) as response:
            body = response.read()
            try:
                return json.loads(body)
            except json.JSONDecodeError:
                raise TTSError(self._explain(response, body)) from None

    @staticmethod
    def _explain(response, body: bytes) -> str:
        """Turn a non-JSON reply into something actionable."""
        final = response.geturl()
        if "cloudflareaccess.com" in final:
            return (
                "Cloudflare Access intercepted the request (redirected to a login page).\n"
                "  A browser can log in; a script needs a service token -- create one under\n"
                "  Zero Trust > Access > Service Auth and export CF_ACCESS_CLIENT_ID and\n"
                "  CF_ACCESS_CLIENT_SECRET."
            )
        return f"expected JSON from {final}, got {body[:80].decode('utf-8', 'replace')!r}"

    # -- API --------------------------------------------------------------

    def health(self) -> dict:
        return self._get_json("/health")

    def voices(self) -> list[str]:
        return self._get_json("/voices")["voices"]

    def stream(
        self,
        text: str,
        *,
        voice: str | None = None,
        speed: float = 1.0,
        lang: str | None = None,
        chunk_size: int = 4096,
    ) -> Iterator[bytes]:
        """Yield raw PCM as the server produces it.

        Requests `format=pcm` rather than `wav`: without a container header
        the bytes can go straight into a player or a ring buffer, and a file
        gets a proper header written locally instead of the streaming one.
        """
        payload = {"text": text, "speed": speed, "format": "pcm"}
        if voice:
            payload["voice"] = voice
        if lang:
            payload["lang"] = lang

        with self._open("/tts", payload) as response:
            # An Access login page comes back as a 200 full of HTML; without
            # this check it would be played as several seconds of noise.
            if response.headers.get_content_type() not in ("application/octet-stream", "audio/wav"):
                raise TTSError(self._explain(response, response.read(200)))
            while True:
                chunk = response.read(chunk_size)
                if not chunk:
                    return
                yield chunk

    def save(self, text: str, path: str, **kwargs) -> str:
        """Stream to a .wav file, header filled in with the real length."""
        with wave.open(path, "wb") as out:
            out.setnchannels(CHANNELS)
            out.setsampwidth(SAMPLE_WIDTH)
            out.setframerate(SAMPLE_RATE)
            for chunk in self.stream(text, **kwargs):
                out.writeframes(chunk)
        return path

    def play(self, text: str, **kwargs) -> None:
        """Play the speech while it is still being synthesized."""
        for name, args in PLAYERS:
            if shutil.which(name):
                break
        else:
            raise TTSError(f"no player found; install one of: {', '.join(p for p, _ in PLAYERS)}")

        player = subprocess.Popen([name, *args], stdin=subprocess.PIPE)
        try:
            for chunk in self.stream(text, **kwargs):
                player.stdin.write(chunk)
            player.stdin.close()
        except BrokenPipeError:  # player was closed early
            pass
        finally:
            player.wait()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("text", nargs="?", help="text to speak; omit to read stdin")
    parser.add_argument("-u", "--url", default=DEFAULT_URL, help=f"API base URL (default {DEFAULT_URL})")
    parser.add_argument("-o", "--output", help="write a .wav file here")
    parser.add_argument("-p", "--play", action="store_true", help="play it as it arrives")
    parser.add_argument("-v", "--voice", help="voice id; see --voices")
    parser.add_argument("-s", "--speed", type=float, default=1.0, help="0.5 to 2.0")
    parser.add_argument("-l", "--lang", help="espeak language, e.g. en-us, en-gb, ja")
    parser.add_argument("--voices", action="store_true", help="list voices and exit")
    args = parser.parse_args(argv)

    tts = TTSClient(args.url)
    try:
        if args.voices:
            print("\n".join(tts.voices()))
            return 0

        text = args.text or sys.stdin.read()
        if not text.strip():
            parser.error("no text given")

        options = {"voice": args.voice, "speed": args.speed, "lang": args.lang}
        if args.play:
            started = time.monotonic()
            tts.play(text, **options)
            print(f"played in {time.monotonic() - started:.1f}s", file=sys.stderr)
        elif args.output:
            tts.save(text, args.output, **options)
            print(args.output, file=sys.stderr)
        else:
            # No destination: stream to stdout so it can be piped anywhere.
            for chunk in tts.stream(text, **options):
                sys.stdout.buffer.write(chunk)
                sys.stdout.buffer.flush()
    except TTSError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        return 130
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
