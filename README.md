# Moneybot TTS

**Twitch chat, read out loud by Kokoro.** A self-hosted streaming text-to-speech server, the browser app a streamer runs it from, and the public page viewers pick their voice on: the three halves of the Monatry TTS bot, in one repo.

## Powered by Kokoro

Every voice in this project comes from **[Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M)**,
hexgrad's 82-million-parameter open-weight TTS model, run locally through
[`kokoro-onnx`](https://github.com/thewh1teagle/kokoro-onnx).

Kokoro is a small model and efficient open-weight TTS model, allowing for faster than real time voice generation on any device.

> Model weights are Apache-2.0; `kokoro-onnx` is MIT. The ~340 MB of model files are downloaded on
> the server's first start and are not vendored in this repo.

## Built by AI

The entire code has been built by Claude Opus 5.0

## The three parts

| Directory | What it is | Runs at |
|---|---|---|
| **[`server/`](server/README.md)** | Streaming TTS API: FastAPI over Kokoro, first audio in ~1.2 s | `:8020`, Docker |
| **[`web/`](web/README.md)** | The streamer's app: Twitch chat, cheers and redeems into speech, plus an OBS avatar overlay | `:3100`, Docker |
| **[`voice-guide/`](voice-guide/README.md)** | Public one-page voice catalogue with a playable sample per voice | static, no container |

Each directory keeps its own detailed README; this README describes the entire project.

```
                  Twitch IRC ──┐
                               ├──→  web/  ──── POST /tts ───→  server/  ──→ Kokoro-82M (ONNX, CPU)
      Twitch EventSub ─────────┘      │                            │
      (channel points, bits)          │        raw 24 kHz PCM  ←────┘
                                      │
                                      ├──→ Web Audio  ──→ the streamer's output device
                                      └──→ BroadcastChannel ──→ /avatar ──→ OBS browser source

                  a viewer types "[af_sky] hello chat"
                               ↑
                        voice-guide/  ── so they know what to type
```

## Quick start

Two containers and a static directory.

```bash
# 1. the TTS server. First start downloads ~340 MB of Kokoro weights into server/models
cd server && docker compose up -d --build
curl -s localhost:8020/health

# 2. the streamer's web app
cd ../web && docker compose up -d --build     # or: npm install && npm run dev

# 3. the voice guide. No build, no container; serve public/ from any web server
cd ../voice-guide && python3 -m http.server -d public 8000
```

Then open <http://localhost:8020/> for the server's own demo box, the web app on
`:3100` (or `:3000` in dev), and the guide on `:8000`.

## Config

Only the web app needs configuration, and it needs exactly two values:

```bash
cd web && cp .env.example .env    # then fill in the two required variables
```

- **`TTS_BASE_URL`** — any instance of `server/`; running it locally that would be
  `http://localhost:8020`.
- **`NEXT_PUBLIC_TWITCH_CLIENT_ID`** — the Client ID of your own app from
  <https://dev.twitch.tv/console/apps>. No client secret is needed: this is the implicit flow
  and the ID is public, which is also why it is baked into the browser bundle at build time
  (change it, then `docker compose up -d --build`).

Neither has a default. If either is unset, `docker compose up` refuses to start.

## How it fits together

**The server** splits text into sentences and streams each one as it finishes, rather than
rendering a whole paragraph before sending a byte. Chunks ramp geometrically (60 chars, then ×1.5
up to 320) so the client's buffer stays ahead of playback. `POST /tts` with
`{"text": ..., "voice": ..., "format": "pcm"}` returns a chunked stream of raw 24 kHz / 16-bit LE
mono samples.

**The web app** keeps all of its data in the streamer's own browser and stores nothing on the
server. Settings, the Twitch token, per-chatter voice assignments and the avatar images live in
localStorage and IndexedDB. Its only server code is `/api/tts/*`, which proxies the TTS server.

**A chatter keeps one voice forever.** A name that has never spoken is assigned a random *English*
voice. Except [af_nicole], because ASMR makes me uncomfortable. Prefixing a message with `[af_sky]` 
repins that chatter to any voice in the catalogue, including the non-English ones. This is all 
explained by the tts-guide app. Intended to be linked on the Channel Point Reward description.

## Repo layout

```
server/        FastAPI + kokoro-onnx streaming TTS service
  app/           engine, chunker, routes
  client/        dependency-free Python client (stdlib only), importable or a CLI
  scripts/       sample_voices.py, renders one wav per voice
  tests/         chunker unit tests
web/           Next.js 15 / React 19 app: the streamer's dashboard and OBS overlay
  src/lib/       bot runtime, TTS queue, Web Audio player, Twitch IRC + EventSub
  src/app/       routes: /login /setup /dashboard /avatar-config /avatar
voice-guide/   the public catalogue page
  public/        index.html, app.js, generated voices.js, 54 wav samples
  tools/         build-voices.py (generates the catalogue), stamp-assets.py (cache busting)
```

## License

[Apache License 2.0](LICENSE.md). Use it, fork it, ship it commercially; keep the notice and state
your changes. It is the same licence the Kokoro weights carry.

Two things in this tree are not covered by it and keep their own terms: the **Kokoro model files**
the server downloads on first start (Apache-2.0, hexgrad, never vendored here) and the **webfonts**
in `voice-guide/public/fonts/`, which are Caprasimo and Figtree, both under SIL Open Font License
1.1.

## Credits

- **[Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M)** by hexgrad, the model every voice
  here comes from. Apache-2.0.
- **[kokoro-onnx](https://github.com/thewh1teagle/kokoro-onnx)**, the ONNX runtime wrapper the
  server calls. MIT.
- Phonemisation via **espeak-ng**; inference via **[ONNX Runtime](https://onnxruntime.ai/)**.
