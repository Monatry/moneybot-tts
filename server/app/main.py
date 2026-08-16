"""HTTP API: text in, audio out, streamed as it is synthesized.

    curl -N -X POST localhost:8020/tts \
         -H 'content-type: application/json' \
         -d '{"text": "Hello there."}' --output - | ffplay -nodisp -i -
"""

from __future__ import annotations

import logging
import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Literal

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import HTMLResponse, StreamingResponse
from pydantic import BaseModel, Field

from .audio import to_pcm16, wav_header
from .config import settings
from .engine import SAMPLE_RATE, Engine

logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
log = logging.getLogger("tts")

# phonemizer warns "words count mismatch" on almost every line of ordinary
# prose; it is cosmetic and would otherwise be most of the log.
logging.getLogger("phonemizer").setLevel(logging.ERROR)

MEDIA_TYPES = {"wav": "audio/wav", "pcm": "application/octet-stream"}


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.engine = Engine(
        settings.model_path, settings.voices_path, workers=settings.workers
    )
    if settings.warmup:
        app.state.engine.warmup(settings.default_voice, settings.default_lang)
        log.info("warmup done")
    try:
        yield
    finally:
        app.state.engine.shutdown()


class ForwardedPrefixMiddleware:
    """Honour `X-Forwarded-Prefix` so the app works under a subpath.

    The reverse proxy strips `/tts` before forwarding, so routing needs no
    help; this only fixes the URLs the app *generates* — Swagger's link to
    openapi.json, redirect_slashes. Reading it per request rather than pinning
    `root_path` at startup keeps direct access on :8020 correct too.
    """

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http":
            for key, value in scope["headers"]:
                if key != b"x-forwarded-prefix":
                    continue
                prefix = value.decode("latin-1")
                # Only a plain absolute path: "//evil.com" or "https://..."
                # would turn a slash-redirect into an open redirect.
                if prefix.startswith("/") and not prefix.startswith("//"):
                    scope = {**scope, "root_path": prefix.rstrip("/")}
                break
        await self.app(scope, receive, send)


app = FastAPI(
    title="Kokoro TTS",
    description="Streaming text-to-speech over HTTP.",
    version="1.0.0",
    lifespan=lifespan,
)
app.add_middleware(ForwardedPrefixMiddleware)


class TTSRequest(BaseModel):
    text: str = Field(..., description="Text to speak.")
    voice: str | None = Field(None, description="Voice id; see GET /voices.")
    speed: float = Field(1.0, ge=0.5, le=2.0)
    lang: str | None = Field(None, description="espeak language, e.g. en-us, en-gb, ja.")
    format: Literal["wav", "pcm"] = "wav"


def _engine(request_app: FastAPI) -> Engine:
    engine = getattr(request_app.state, "engine", None)
    if engine is None:  # pragma: no cover - lifespan always sets it
        raise HTTPException(503, "model not loaded")
    return engine


def _validate(engine: Engine, req: TTSRequest) -> TTSRequest:
    text = req.text.strip()
    if not text:
        raise HTTPException(400, "text is empty")
    if len(text) > settings.max_text_chars:
        raise HTTPException(
            413, f"text is {len(text)} chars, limit is {settings.max_text_chars}"
        )
    voice = req.voice or settings.default_voice
    if not engine.has_voice(voice):
        raise HTTPException(400, f"unknown voice {voice!r}; see GET /voices")
    return req.model_copy(
        update={"text": text, "voice": voice, "lang": req.lang or settings.default_lang}
    )


def _speak(engine: Engine, req: TTSRequest) -> StreamingResponse:
    """Validated request in, streaming audio response out."""

    async def body() -> AsyncIterator[bytes]:
        # The container header goes out before the first inference so the
        # client has bytes in hand while chunk one is still being made.
        if req.format == "wav":
            yield wav_header(SAMPLE_RATE)
        async for samples in engine.stream(
            req.text,
            voice=req.voice,
            speed=req.speed,
            lang=req.lang,
            first_limit=settings.first_chunk_chars,
            limit=settings.chunk_chars,
            growth=settings.chunk_growth,
            prefetch=settings.prefetch,
        ):
            yield to_pcm16(samples)

    return StreamingResponse(
        body(),
        media_type=MEDIA_TYPES[req.format],
        headers={
            "X-Sample-Rate": str(SAMPLE_RATE),
            "X-Audio-Format": "s16le",
            "X-Channels": "1",
            "X-Voice": req.voice or "",
            "Cache-Control": "no-store",
            # Belt and braces: any nginx in front streams this through even if
            # its own proxy_buffering is left on.
            "X-Accel-Buffering": "no",
            "Content-Disposition": f'inline; filename="speech.{req.format}"',
        },
    )


@app.post("/tts", response_class=StreamingResponse)
async def tts(req: TTSRequest) -> StreamingResponse:
    """Speak `text`, streaming the audio as it is synthesized."""
    engine = _engine(app)
    return _speak(engine, _validate(engine, req))


@app.get("/tts", response_class=StreamingResponse)
async def tts_get(
    text: str = Query(..., description="Text to speak."),
    voice: str | None = None,
    speed: float = Query(1.0, ge=0.5, le=2.0),
    lang: str | None = None,
    format: Literal["wav", "pcm"] = "wav",
) -> StreamingResponse:
    """Same as POST /tts, for anything that can only fetch a URL."""
    engine = _engine(app)
    req = TTSRequest(text=text, voice=voice, speed=speed, lang=lang, format=format)
    return _speak(engine, _validate(engine, req))


@app.get("/voices")
async def voices() -> dict:
    engine = _engine(app)
    return {
        "default": settings.default_voice,
        "count": len(engine.voices),
        "voices": engine.voices,
    }


@app.get("/health")
async def health() -> dict:
    engine = getattr(app.state, "engine", None)
    return {
        "status": "ok" if engine else "loading",
        "sample_rate": SAMPLE_RATE,
        "voices": len(engine.voices) if engine else 0,
    }


@app.get("/", response_class=HTMLResponse)
async def index() -> str:
    return DEMO_PAGE


DEMO_PAGE = """<!doctype html>
<meta charset="utf-8"><title>Kokoro TTS</title>
<style>
 body{font:16px/1.5 system-ui,sans-serif;max-width:44rem;margin:3rem auto;padding:0 1rem}
 textarea{width:100%;height:7rem;font:inherit;padding:.5rem}
 select,button{font:inherit;padding:.4rem}
 audio{width:100%;margin-top:1rem}
 code{background:#8881;padding:.1rem .3rem;border-radius:.2rem}
</style>
<h1>Kokoro TTS</h1>
<textarea id="text">Hello! Type something here and press speak.</textarea>
<p><select id="voice"></select>
   <label>speed <input id="speed" type="number" value="1" min="0.5" max="2" step="0.1" size="3"></label>
   <button id="go">Speak</button></p>
<audio id="out" controls autoplay></audio>
<p>API: <code>POST /tts</code> · <code>GET /tts?text=...</code> · <code>GET /voices</code></p>
<script>
fetch('voices').then(r => r.json()).then(d => {
  voice.innerHTML = d.voices.map(v => `<option${v === d.default ? ' selected' : ''}>${v}</option>`).join('');
});
go.onclick = () => {
  const q = new URLSearchParams({text: text.value, voice: voice.value, speed: speed.value});
  out.src = 'tts?' + q;
};
</script>
"""
