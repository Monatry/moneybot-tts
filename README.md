# Moneybot TTS

**Twitch chat, read out loud by Kokoro.** A self-hosted streaming text-to-speech server, the browser app a streamer runs it from, and the public page viewers pick their voice on: the three halves of the Monatry TTS bot, in one repo.

## Powered by Kokoro

Every voice in this project comes from **[Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M)**,
hexgrad's 82-million-parameter open-weight TTS model. It is small and efficient enough for faster
than real time generation on ordinary hardware.

> Model weights are Apache-2.0; `kokoro-onnx` is MIT and `kokoro-js` is Apache-2.0. No model files
> are vendored in this repo

## Built by AI

The entire code has been built by Claude Opus 5.0

## The three parts

| Directory | What it is | Runs at |
|---|---|---|
| **[`server/`](server/)** | Streaming TTS API: FastAPI over Kokoro, first audio in ~1.2 s | `:8020`, Docker |
| **[`web/`](web/)** | The streamer's app: Twitch chat, cheers and redeems into speech, plus an OBS avatar overlay | `:3100` / `:3101`, Docker |
| **[`voice-guide/`](voice-guide/)** | Public one-page voice catalogue with a playable sample per voice | static, no container |

Each directory keeps its own detailed README; this README describes the entire project.
`server/` is optional: the browser engine does not use it.

```
                  Twitch IRC ──┐
                               ├──→  web/  ──┬─ server engine ─ POST /tts ─→ server/ ─→ Kokoro-82M
      Twitch EventSub ─────────┘      │      │                     │           (ONNX, CPU)
      (channel points, bits)          │      │  raw 24 kHz PCM ←───┘
                                      │      │
                                      │      └─ browser engine ─→ worker ──→ Kokoro-82M
                                      │                                    (kokoro-js, WASM/WebGPU)
                                      │
                                      ├──→ Web Audio  ──→ the streamer's output device
                                      └──→ BroadcastChannel ──→ /avatar ──→ OBS browser source

                  a viewer types "[af_sky] hello chat"
                               ↑
                        voice-guide/  ── so they know what to type
```

## Two ways to run the speech

The same source tree in `web/` builds against either engine, chosen by the
`NEXT_PUBLIC_TTS_ENGINE` build argument.

| | **`server`** (default) | **`browser`** |
|---|---|---|
| Synthesised by | `server/`, over HTTP | `kokoro-js` in a Web Worker, in the page |
| Needs `server/` running | yes | **no** |
| Compose file | `docker-compose.yaml` | `docker-compose.browser.yaml` |
| Container · port | `moneytts` · `:3100` | `moneytts-browser` · `:3101` |
| Voices | all **54** | the **28 English ones** |
| Good for | one machine doing the work for any number of streamers | a public URL where every visitor brings their own compute |

Two things to know before choosing `browser`:

- **Only the English voices.** `kokoro-js` maps `af_*`, `am_*`, `bf_*` and `bm_*` only, so
  `[jf_alpha]`-style prefixes do nothing on that build even though `voice-guide/` still advertises
  all 54. Chatters pinned to a voice it does not have are silently re-rolled.
- **WebGPU is not always trustworthy.** The app picks WebGPU where the browser offers a working
  adapter and falls back to WebAssembly otherwise, but a driver can accept the adapter and then
  produce *garbled audio* rather than failing outright. The app cannot detect this. If speech 
  comes out as noise, switch to "Processor (WebAssembly)". If that is too slow to keep up with 
  chat on your hardware, the server engine is the answer.

## Quick start

Pick an engine. The voice guide is a static directory either way.

**Browser engine**: one container, nothing else to run.

```bash
cd web && cp .env.example .env      # fill in NEXT_PUBLIC_TWITCH_CLIENT_ID
docker compose -f docker-compose.browser.yaml up -d --build
```

The app is on `:3101`. Speech is generated in whatever browser you open it in; the weights arrive
from the Hugging Face CDN on first use and come out of the browser's cache after that.

**Server engine**: two containers:

```bash
# 1. the TTS server. First start downloads ~340 MB of Kokoro weights into server/models
cd server && docker compose up -d --build
curl -s localhost:8020/health

# 2. the streamer's web app
cd ../web && docker compose up -d --build     # or: npm install && npm run dev
```

The app is on `:3100` (or `:3000` in dev), and <http://localhost:8020/> is the server's own demo box.

**The voice guide**, for either:

```bash
cd voice-guide && python3 -m http.server -d public 8000    # no build, no container
```

## Config

Only the web app needs configuration, and how much depends on the engine:

```bash
cd web && cp .env.example .env
```

- **`NEXT_PUBLIC_TWITCH_CLIENT_ID`** - *always required.* The Client ID of your own app from
  <https://dev.twitch.tv/console/apps>. No client secret is needed: this is the implicit flow
  and the ID is public, which is also why it is baked into the browser bundle at build time
  (change it, then `docker compose up -d --build`).
- **`TTS_BASE_URL`** - *server engine only.* Any instance of `server/`; running it locally that
  would be `http://localhost:8020`. The browser engine never reads it, and its compose file does
  not ask for it.
- **`NEXT_PUBLIC_TTS_ENGINE`** - `server` (default) or `browser`. The two compose files set it
  themselves; set it in `.env` only to pick an engine for `npm run dev`.

Twitch compares `redirect_uri` as a raw string, so register `<your-url>/auth/callback` for **every**
URL you serve the app from, including `http://localhost:3000/auth/callback` for dev. A missing one
is a `redirect_mismatch` at the sign-in button, not a subtle failure.

## How it fits together

**The server** splits text into sentences and streams each one as it finishes, rather than
rendering a whole paragraph before sending a byte. Chunks ramp geometrically (60 chars, then ×1.5
up to 320) so the client's buffer stays ahead of playback. `POST /tts` with
`{"text": ..., "voice": ..., "format": "pcm"}` returns a chunked stream of raw 24 kHz / 16-bit LE
mono samples.

**The web app** keeps all of its data in the streamer's own browser and stores nothing on the
server. Settings, the Twitch token, per-chatter voice assignments and the avatar images live in
localStorage and IndexedDB. On the server engine its only server code is `/api/tts/*`, which
proxies the TTS server because that service sends no CORS headers; on the browser engine there is
no server code in play at all. The container hands over a bundle and is never spoken to again.

**The browser engine runs inference in a Web Worker**, never on the main thread. A sentence is a
few hundred milliseconds to a few seconds of solid CPU, and the thread it would otherwise block is
the one scheduling audio on the Web Audio clock and animating the avatar. It streams a sentence at
a time, the same shape the server does, so a long message starts speaking before it has finished
generating.

**A chatter keeps one voice forever.** A chatter that has never spoken is assigned a random *English*
voice. Except [af_nicole], because she's a problem. Prefixing a message with `[af_sky]` 
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
  src/lib/kokoro/  browser engine: the worker, its protocol, and the page's half of it
  src/app/       routes: /login /setup /dashboard /avatar-config /avatar
  src/app/api/tts/ server engine only: the proxy to server/
voice-guide/   the public catalogue page
  public/        index.html, app.js, generated voices.js, 54 wav samples
  tools/         build-voices.py (generates the catalogue), stamp-assets.py (cache busting)
```

## License

[Apache License 2.0](LICENSE.md). Use it, fork it, ship it commercially; keep the notice and state
your changes. It is the same licence the Kokoro weights carry.

Two things in this tree are not covered by it and keep their own terms: the **Kokoro model files**
(Apache-2.0, hexgrad, not vendored here. Downloaded on the server's first start, or by the
browser on the browser engine) and the **webfonts**
in `voice-guide/public/fonts/`, which are Caprasimo and Figtree, both under SIL Open Font License
1.1.

## Credits

- **[Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M)** by hexgrad, the model every voice
  here comes from. Apache-2.0.
- **[kokoro-onnx](https://github.com/thewh1teagle/kokoro-onnx)**, the ONNX runtime wrapper the
  server calls. MIT.
- **[kokoro-js](https://github.com/hexgrad/kokoro/tree/main/kokoro.js)** by hexgrad and Xenova,
  which runs the same model in the browser. Apache-2.0.
- **[Transformers.js](https://github.com/huggingface/transformers.js)**, which `kokoro-js` runs on.
  Apache-2.0.
- Phonemisation via **espeak-ng**; inference via **[ONNX Runtime](https://onnxruntime.ai/)** 
  natively on the server, and as WebAssembly or WebGPU in the browser.
