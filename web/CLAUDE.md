# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`moneybot-tts` — a Next.js 15 / React 19 App Router app, a browser port of the MonatryTTS
WinForms desktop app. A Twitch streamer signs in, picks which events get read aloud (chat,
cheers, channel-point redeems), and runs the bot from a dashboard. `/avatar` is a separate
route meant to be pasted into OBS as a browser source.

**It builds against one of two synthesis engines**, chosen by `NEXT_PUBLIC_TTS_ENGINE` and
baked into the bundle (`src/lib/ttsEngine.ts`). Everything above `src/lib/ttsClient.ts` is
identical between them:

| | `server` (default) | `browser` |
|---|---|---|
| Synthesised by | a Kokoro instance of `../server`, relayed through `/api/tts/*` | `kokoro-js` in the streamer's own browser, in a worker |
| Needs | `TTS_BASE_URL`, a reachable box | nothing but the Twitch client ID |
| Voices | all 54 the server carries | **the 28 English ones only** — see below |
| Stack | `docker-compose.yaml` → `moneytts` :3100 | `docker-compose.browser.yaml` → `moneytts-browser` :3101 |
| Deployed at | `private.woof-i-am-a.dog/moneytts`, behind Cloudflare Access | `woof-i-am-a.dog/moneytts`, public |

Two builds rather than a runtime toggle because the choice *is* the deployment: the server
build has an upstream that answers to whoever can reach it, which is what the Access gate in
front of it is for, and the browser build has no upstream at all, so the only thing an
unknown visitor can spend is their own CPU. A runtime switch would mean shipping a container
half-configured for whichever half is off.

The server's `../../CLAUDE.md` describes the surrounding docker-compose collection and the nginx
reverse proxy this app is served behind — read it before touching deployment.

## Commands

```bash
npm install
npm run dev        # localhost:3000
npm run build
npm run typecheck  # tsc --noEmit
```

`npm run dev` builds whichever engine `./.env` names in `NEXT_PUBLIC_TTS_ENGINE` (unset =
`server`), because Next loads that file itself — so dev and the containers read the same
config and cannot drift.

**There are no tests.** `npm run typecheck` and `npm run build` are the only checks — don't
go looking for a test runner or invent one unasked. When something in `src/lib/kokoro/`
needs proving, kokoro-js runs under plain node (`device: "cpu"`) with the same generation
API the worker uses, so a throwaway script in a `node:22` container will reproduce a
synthesis bug without a browser — that is how the unclosed-splitter hang above was pinned
down.

The host's own `node` is v10 and cannot run any of this. Use the Docker stack (below) for
anything that has to actually execute.

## Architecture

```
                                         ┌─ server engine ─→ /api/tts/* ─→ ../server
TwitchIrcClient ─┐                       │
                 ├─→ Bot ─→ TtsQueue ─→ ttsClient
TwitchEventSub ──┘   │                   │
                     │                   └─ browser engine ─→ kokoro worker (kokoro-js)
                     │                                              │
                     │                        ┌─────────────────────┘
                     │                        ↓
                     │                   PcmPlayer (Web Audio) ─→ output device
                     │                        └─→ BroadcastChannel ─→ /avatar overlay window
                     └─→ chat log, stats
```

Almost everything is client-side. On the browser engine, *everything* is: the server's one
job is proxying the TTS server, and that build has no TTS server.

- **`src/lib/bot.ts` is a module-level singleton, not React state**, and must stay that way.
  It has to outlive the component tree — moving between `/dashboard` and `/avatar-config`
  must not drop the IRC connection or the queue. React reads it through `useBot()`
  (`useSyncExternalStore`). Same pattern in `src/lib/settings.ts` (`settingsStore`).
- **`src/lib/ttsQueue.ts`** — the queue runner, ported from the desktop `TtsQueueService`.
  Its ordering rules (hold before dequeue, gap measured from the *end* of the previous
  message and read live, skip cuts the hold short rather than discarding) are deliberate and
  documented at the site.
- **`src/lib/audioPlayer.ts`** — replaces NAudio. Chunks become AudioBuffers scheduled back
  to back on the context clock. `push` takes **either** raw 16-bit PCM bytes (server engine,
  arriving split at arbitrary offsets and re-joined a sample at a time) **or** float samples
  (browser engine, already the shape an AudioBuffer wants). Converting one to the other at
  the seam would mean quantising the local model's output for nothing.
- **`src/lib/ttsClient.ts`** — the seam. `fetchVoices` / `openPcmStream` dispatch on the
  build-time engine constant; nothing above it knows which is behind it.
- **`src/server/kokoro.ts` + `src/app/api/tts/*`** — the only server code. Dead weight in a
  browser-engine build (never called; `TTS_BASE_URL` is unset there), kept so one tree
  builds both.

### The browser engine

`src/lib/kokoro/` — `worker.ts` (kokoro-js, in a worker), `localTts.ts` (the page's half),
`protocol.ts` (the messages, imported by both).

- **It must be a worker.** Inference is a few hundred ms to a few seconds of solid CPU per
  sentence, and the page it would otherwise block is the one scheduling audio on the Web
  Audio clock and animating the avatar at 100 ms. On the main thread a long message stutters
  its own playback. Only `protocol.ts` crosses the boundary, so kokoro-js, transformers.js
  and onnxruntime-web stay in the worker chunk and out of the page bundle entirely.
- **The splitter must be closed by hand.** `tts.stream(someString)` builds a
  `TextSplitterStream` internally and never closes it — and that splitter holds back a
  sentence whose terminator is the last thing in its buffer, waiting for text that proves it
  was not an abbreviation. Nothing more arrives, so **a one-sentence chat message produces no
  audio at all and the iterator blocks forever**: the dashboard sits on "now speaking" in
  silence, Skip cannot rescue it (the worker's cancel is only read between sentences, and it
  never reaches one), and every later message queues behind it for the rest of the stream.
  A multi-sentence message loses only its last sentence before hanging the same way. Build
  the `TextSplitterStream`, `push`, `close`, then `stream(splitter)`. `localTts.ts` also
  carries a first-chunk watchdog so a future stall degrades to one skipped message.
- **Only 28 voices.** kokoro-js' `VOICES` map is American and British English (`af_*`,
  `am_*`, `bf_*`, `bm_*`) — the `voices/` directory in the package holds all 54 bins, but the
  other 26 are not in the map and `_validate_voice` rejects them. So `[jf_alpha]`-style
  prefixes do nothing on this build, and `/tts-guide` (which lists all 54) over-promises for
  it. Chatters pinned to a retired id are silently re-rolled, which `userVoices.ts` already
  handled for the server case.
- **Weights come from the Hugging Face CDN, not from this container**, into the browser's
  Cache Storage — once per browser, ~86 MB at q8. The ORT wasm binary likewise comes from
  jsdelivr (transformers.js' default `wasmPaths`). Self-hosting either was considered and
  rejected: the weights would mean this home server serving 86 MB per visitor on a public
  URL, and self-hosting only the wasm buys nothing while the weights are still remote.
- **Backend is `auto` by default** — WebGPU at fp32 where `requestAdapter()` succeeds, WASM
  at q8 otherwise, with a fallback to WASM if the WebGPU graph fails to run. The setup screen
  exposes both as overrides, because a driver that accepts the adapter and then fails is
  common enough that a streamer needs to be able to say "just use the CPU". Changing either
  rebuilds the worker: an ONNX session cannot be re-targeted.
- **The load is warmed up before `ready`.** `from_pretrained` returning is not the model
  working; creating the session and compiling the graph is where a broken backend actually
  throws. Doing it eagerly puts the failure on the setup screen with a progress bar in front
  of it instead of on the first cheer of the stream.
- Cross-origin isolation (COOP/COEP) would let onnxruntime-web use threads and roughly
  triple WASM throughput. It is **not** set: `require-corp` needs every cross-origin
  subresource to co-operate (the HF CDN, jsdelivr) and `credentialless` is not in Safari, so
  it is a change that has to be verified in a browser before it goes near a live stream.

### Why only the TTS server is proxied

Server engine only; the browser engine proxies nothing at all.

The TTS server (`../server`) sends no `Access-Control-Allow-Origin` on any host, so a browser
fetch is blocked before it is sent — hence `/api/tts/*`. Twitch's `oauth2/validate`,
`helix/*` and the IRC/EventSub websockets all answer with `Access-Control-Allow-Origin: *`
for the methods used here, so they are called straight from the browser and **the OAuth
token never passes through this app's server**. Keep it that way.

The TTS URL in `src/server/kokoro.ts` comes from **`TTS_BASE_URL`, which is required and has
no default**. It lives in `./.env` (gitignored, `.env.example` is the tracked template), which
compose interpolates with `${TTS_BASE_URL:?...}` so an unset value stops `docker compose up`
rather than starting a misaimed container. `.env*` is in `.dockerignore`: the builder does
`COPY . .`, and a .env in the context would be loaded by `next build` and left in a layer.

Do not add a fallback: guessing an upstream host is how a streamer's chat ends up posted to
somebody else's box, so unset must stay a loud failure. It is read inside `baseUrl()` rather
than at module scope because `next build` imports this module with no runtime environment, and
a top-level throw would fail the image build instead of the request. Keep it off
`NEXT_PUBLIC_*` so it stays server-side. Note the doubled
`/tts/tts` in the synthesis path is correct (the OpenAPI doc declares `servers: [{url:
"/tts"}]`, and POSTing to the bare base 301s to an `http://` URL that fetch refuses).

### Audio contract

Raw **24 kHz / 16-bit LE / mono PCM**, `format: "pcm"` in the request. The server's default
is `wav`, whose 44-byte RIFF header would be played as audio. Two invariants:

- **`startedAt` is stamped by the first `flush`, not by `begin`** — anchoring at the request
  counts synthesis latency as audio already played and the progress bar jumps to halfway.
- **`isSpeaking` means samples are reaching the device**, not "a message is in progress".
  The avatar mouth and coin bounce gate on it; animating off the start event flaps them over
  the silence before the first chunk.

Output device selection uses `AudioContext.setSinkId` — Chromium-only. Elsewhere the choice
is stored but the OS default plays.

### The overlay

`/avatar` and the preview rail on `/avatar-config` both render **`components/AvatarStage.tsx`**
— they were two implementations of the same layer stack and drifted. Keep it that way: the
preview is what a streamer places the caption and the bob anchor by, so anything drawn in one
has to be drawn by the other.

- **With no images, the overlay draws nothing.** No logo, no placeholder — it sits in a live
  scene, and a placeholder there is a bug the streamer finds on stream.
- Every size it draws is a **fraction of the stage's height** (caption size, bob rise), so a
  200 px preview tile and a 1080p browser source compose identically. The caption's font size
  needs the measured height, which is the one `ResizeObserver` in the component.
- The overlay window **hydrated its own copy of `localStorage` when it opened** and never sees
  a later write from the dashboard. Every field it paints therefore has to arrive over
  BroadcastChannel: `settings` carries the whole `settings.avatar` object (re-normalized on
  arrival — it is the one path in that has not been through the store) and `speaking` carries
  the flag *and* the line, so the caption appears and disappears with the audio exactly as the
  mouth does.
- The three effects — crossfade, caption, bob — are **off by default**, and the baseline
  behaviour with all three off is the plain idle/talking swap the config screen has always
  described.
- **The crossfade is between the two states, not between frames.** A fade longer than the
  frame hold (83 ms at 12 fps) smears the mouth into a permanent blur, so the idle image and
  the talking frames are two groups and only the groups fade. That means **one frame stays lit
  inside the talking group even when the queue is quiet**, and the cycling index is not reset
  on stop — blank the group's contents when speaking ends and it fades out from nothing, so
  the talking→idle half of the crossfade silently disappears while the idle→talking half
  still works.
- **The bob is a rotation around the anchor and nothing else** — no rise, no scale. It
  imitates a head moving as it talks, so it runs while a line is being read and rests
  otherwise, and its shape is deliberately asymmetric: `attackMs` out to `angle`, `decayMs`
  back to `minAngle`, with the easing set per keyframe so the two halves stay unequal. Rest is
  `minAngle`, not zero, so the stack carries an inline `transform` of that pose — a running
  animation outranks an inline declaration, so it only shows between bobs, and without it an
  avatar that rests off zero snaps upright the moment a line ends. `flip` mirrors both ends.
- **The bob is Web Animations, not a CSS animation**, because its speed is re-rolled between
  `speedMin` and `speedMax` on **every** swing. A CSS animation takes one duration up front,
  and writing a new `animation-duration` onto a running one rescales its elapsed time instead
  of restarting it — the avatar jumps mid-swing. So `useBob` chains single runs off
  `finished`, and the roll lands on `playbackRate`: the shape is written once and only its
  tempo varies, and every roll starts from rest where a change is invisible. `finished`
  rejects on cancel, so the chain has to swallow that or unmounting throws.

### Storage

| What | Where |
| --- | --- |
| Settings + auth token | `localStorage` `moneybot.settings.v1` |
| Per-chatter voices | `localStorage` `moneybot.uservoices.v1` (own key so a settings rewrite can't clobber it) |
| Bits read today | `localStorage` `moneybot.bitsToday.v1`, keyed by date |
| Avatar images | IndexedDB `moneybot-avatar` (up to 4 MB each; would blow the localStorage budget) |
| Kokoro weights (browser engine) | Cache Storage, written by transformers.js — not ours, not cleared by "clear settings", and the reason a reload is fast after the first one |

`settings.ts` merges stored blobs **one level deep**, not with a flat spread — an older blob
missing a whole sub-object would otherwise reach the app without its defaults.

Anything that routes on stored state (`setupComplete`, `auth.channel`) must wait on
`useSettingsReady()`. Acting on the pre-hydration snapshot bounces returning users to
`/login`.

The token sits in plaintext in `localStorage`. That is a knowing tradeoff versus the desktop
app's DPAPI wrapping — it's a scoped, revocable, non-refreshable implicit-flow token. See
`README.md`, "Token storage".

### Twitch

The client ID comes from **`NEXT_PUBLIC_TWITCH_CLIENT_ID`** in `./.env`, with no default in
the source — same reasoning as `TTS_BASE_URL`, since the app a token is issued for decides
which redirect URLs count and who can revoke it. It is public by design (implicit flow, no
secret), so `NEXT_PUBLIC_` costs nothing — but that makes it *build*-time like
`NEXT_PUBLIC_BASE_PATH`: compose passes it as a build arg and changing it needs `--build`.
`requireClientId()` in `src/lib/twitchAuth.ts` is what turns an unset value into a message
naming the variable instead of a Twitch error page or a bare Helix 401.

**Twitch compares `redirect_uri` as a raw string**, so every origin *and path* the
app is served from needs its own registration in the developer console — a missing one is
`redirect_mismatch`, not a subtle failure. See "Deployment" below for the deployed value.

Behaviour worth not breaking:

- `chat:read` is not optional once a token exists — the token doubles as the IRC password,
  and Twitch rejects one without it with "Login authentication failed" and then drops the
  socket, which looks like a network fault. `validateToken` before every connect is what
  tells the two apart. No token at all is fine: `justinfan` reads chat and cheers.
- The IRC username is the **token owner's login**, not the channel being watched.
- EventSub tears the socket down before every reconnect. A second live websocket is a second
  session with its own subscription, and every redemption gets spoken twice.

### Conventions carried from the desktop app

- **`AccessDeniedError`** — `message` is always the generic "You are not whitelisted. Reach
  out to Monatry."; the real cause travels in `detail`. Always populate `detail` when
  throwing, and always render it under the message — it is the only way to tell a genuine
  rejection from a routing fault. There are two mirrored copies, server (`server/kokoro.ts`)
  and client (`lib/ttsClient.ts`).
- **`cleanChatText` runs at the point a message enters the app**, before the `[voice]` prefix
  is matched — Kokoro narrates characters it can't pronounce, and invisible characters break
  the prefix regex.
- **A chatter keeps one voice forever.** New names get a random *English* voice only (Kokoro
  prefixes ids by language; `a`/`b` are the English ones). A `[voice]` prefix repins to any
  voice including non-English. A stored voice the server has retired is silently re-rolled.
- **An empty redeem name matches nothing**, not everything.
- **No chat composer.** The app reads chat and never posts, which is what the login screen
  promises. The design draws one; it is omitted by request.
- **No "Connect your channel" setup step.** The design's screen 1b asked for the channel and
  the token that `/login` has already collected, so it was removed by request — `/setup` is
  now the preferences screen alone.

Queue durations and the "6 waiting · 1m 12s" total are estimates from a three-point linear
fit in `estimateSeconds` (~0.06 s/char + 0.3 s fixed). Re-measure if the TTS model changes.

## Routes

| Route | Screen |
| --- | --- |
| `/` | redirects by state: login → setup → dashboard |
| `/login` | Twitch OAuth, or channel + pasted token |
| `/setup` | triggers and audio preferences |
| `/dashboard` | queue, chat, controls |
| `/avatar-config` | idle image, talking frames, fps, background, crossfade / caption / bob |
| `/avatar` | OBS browser source, transparent background |
| `/auth/callback` | reads the OAuth fragment and `postMessage`s it to the opener |

`window.__moneybot` exposes the runtime in development builds only.

## Design handoff

`design_handoff_moneybot_tts/` is **reference material, not source** — a static HTML
prototype of the five designed screens. It is excluded from `tsconfig.json` and from Next's
file tracing, and `support.js` in there is the prototype's own runtime, to be ignored.

The design took precedence wherever it disagreed with the desktop app; `README.md` has the
full table of what changed and the deliberate departures from the design. Tokens live in
`src/app/globals.css` (the handoff stylesheet with the mock's palette override folded in) —
fonts come from `next/font/google` in `layout.tsx`, so there is no `@import`.

Styling is CSS Modules per screen/component. No CSS framework, no component library beyond
`lucide-react` icons.

## Deployment

Served at **`https://<host>/moneytts`** behind a reverse proxy
(`../../nginx/templates/default.conf.template`). **Two stacks are deployed from this one
directory**, one per engine, and they are independent — building or restarting either leaves
the other's container alone:

```bash
# server engine → private.woof-i-am-a.dog/moneytts, container `moneytts`, :3100
docker compose up -d --build

# browser engine → woof-i-am-a.dog/moneytts, container `moneytts-browser`, :3101
docker compose -f docker-compose.browser.yaml up -d --build
docker compose -f docker-compose.browser.yaml logs -f
```

Both compose files pin a `name:` (`moneytts`, `moneytts-browser`), which is what keeps their
images and containers from colliding — without it they would be one project and each `up`
would replace the other.

- Each container serves the `output: "standalone"` bundle on its own port 3000, published to
  **`127.0.0.1:3100`** and **`127.0.0.1:3101`**. Loopback only — the root nginx runs
  `network_mode: host` and reaches them there. Neither has volumes and both run
  unprivileged: all state is in the streamer's browser.
- **`basePath`** in `next.config.ts` is what makes the subpath work — nginx passes the prefix
  through unrewritten and Next owns it. It is read from `NEXT_PUBLIC_BASE_PATH`, set to
  `/moneytts` by the compose build arg, so **`npm run dev` still runs at the root**. It is
  resolved at *build* time: changing it needs `--build`, not a restart, and it must stay in
  step with the location block in `../../nginx/templates/default.conf.template`.
- `basePath` rewrites `next/link`, the router and static assets — but **not** raw browser
  APIs: `window.open()`, `location.replace()`, `window.location.origin`, or a bare `fetch()`.
  Those must go through `withBasePath()` / `appOrigin()` in `src/lib/basePath.ts`. This is
  the one thing that silently breaks *only* in production, because dev runs with an empty
  prefix — and a `<Link>` sitting right next to an offending `window.open` will look fine,
  which is what makes it easy to miss. Five sites use it today: both fetches in
  `ttsClient.ts`, `redirectUri()`, the same-tab OAuth fallback in `auth/callback`, the OBS
  overlay URL on `/avatar-config`, and the "Open avatar view" popup on the dashboard.
- On the private host nginx has a **second, longer-prefix location for `/moneytts/api/tts/`**
  with `proxy_buffering off` — the synthesis route relays the Kokoro stream and the browser
  schedules PCM as it arrives, so buffering would hold each message back until it was fully
  synthesised. The public host's block has no such pair: the browser engine never calls those
  routes, and its one long fetch (the weights) goes browser → Hugging Face without touching
  nginx. There is deliberately **no** `/moneytts` → `/moneytts/` redirect on either: Next 308s
  the trailing-slash form back, and the pair would loop.
- In the example deployment the private host sits behind **Cloudflare Access**, so the
  server-engine app is gated by an Access login on top of everything else. Requests from the
  house IP bypass it, which makes it easy to forget when testing locally. The public host is
  **not** behind Access, which is the point of putting the browser build there — it has no
  upstream to protect.
- The Twitch developer console must list
  `https://<host>/moneytts/auth/callback` as an OAuth Redirect URL for every host it is served
  from, in
  addition to `http://localhost:3000/auth/callback` for dev. Raw string comparison — the
  `/moneytts` segment matters. **Both stacks sign in as the same Twitch app**, so the public
  host needs its own registration; the private one's does not cover it, and a missing one is
  a `redirect_mismatch` at the sign-in button.
- The Docker build needs network access: `next/font/google` fetches Caprasimo and Figtree at
  build time.
</content>
