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

# Landing-page voice samples. Stdlib python + ffmpeg, needs a running ../server; writes
# public/samples/*.mp3 and the generated src/lib/previewSamples.ts. Not part of the build —
# run it by hand when the line, the voice list or the TTS model changes.
python3 tools/build-samples.py [http://127.0.0.1:8020]
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
  a later write from the dashboard. Every field it paints therefore has to arrive over the
  channel: `settings` carries the whole `settings.avatar` object (re-normalized on
  arrival — it is the one path in that has not been through the store) and `speaking` carries
  the flag *and* the line, so the caption appears and disappears with the audio exactly as the
  mouth does.
- **There are two transports under `subscribeAvatarMessages`, and the overlay picks neither.**
  It listens on both and paints whatever arrives. Which one is live depends on where the
  overlay is running, and that is the whole of `lib/obsBridge.ts` — see below.
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

### The OBS bridge

`src/lib/obsBridge.ts` — the overlay's second transport, for when it runs as an **OBS browser
source** rather than in a browser window.

The reason it exists is that a browser window is a bad place for an overlay. Chrome stops
producing frames for a page it considers not-visible — background tab, minimized, *or fully
covered by another window* — so the avatar freezes exactly when a streamer has put something
else on top of it. No page-level API opts out of that; the fix is to not be a browser window.
But a browser source is CEF, with **its own profile**: no BroadcastChannel peer, no access to
the IndexedDB the dashboard wrote, its own `localStorage`. So everything the overlay paints
has to be carried there.

obs-browser registers an obs-websocket vendor named `obs-browser` whose `emit_event` request
dispatches a `CustomEvent` into every browser source. That is the hop. `postAvatarMessage`
fans out to BroadcastChannel *and* this bridge; `subscribeAvatarMessages` listens on both.
Nothing above those two functions knows a bridge exists.

- **It is one-way, and that shapes everything.** `window.obsstudio` exposes OBS to the page
  and gives it no route back out to obs-websocket, so the overlay can never ask for anything
  — no hello, no retry, no acknowledgement. The dashboard therefore *pushes* the whole state
  on connect (`setObsReadyHandler`), the overlay **caches the images it receives in its own
  IndexedDB** so a restarted OBS paints before the dashboard reconnects, and the config screen
  keeps a manual "Send avatar now" for the case neither covers. Do not add a request/response
  shape here; there is no channel for the response.
- **The images must be chunked, and the reason is not the WebSocket.** obs-websocket takes a
  multi-megabyte frame happily; OBS then gets it into the browser source's renderer by
  **concatenating a `new CustomEvent(...)` script around the payload and `Eval`ing it**, and
  the `Eval`'s exception is captured and never handled. So an oversized payload fails
  silently at both ends. The symptom is precise and misleading: `settings` and `speaking`
  arrive, the overlay changes background and transparency, and the images simply never
  appear — which reads as a bug in the image path rather than a size ceiling. Hence
  `CHUNK_CHARS` (16 KB) and `PACE_MS`; both are empirical, and **raising either is the first
  thing to suspect** if images stop arriving again.
- **Every image message carries the `push` it belongs to, and this is load-bearing.** A push
  runs for seconds and three things start one — connecting, Save, and the button — so two
  streams overlapping is ordinary. Untagged, a second `images-begin` resets the set the first
  was still filling and parts land against the wrong head; what you see is a set that arrives
  *partially and differently each time*, which looks like a lossy transport rather than a
  concurrency bug. Latest wins: the older push checks `pushSeq` and abandons itself, and the
  receiver drops anything not tagged with the set it is assembling.
- An incomplete set is **applied anyway**, with the gaps compacted out — a shorter talking
  cycle beats leaving the scene with a stale avatar, or nothing at all on a first run.
  `waitForObsDrain` runs between *slices*, but only `bufferedAmount` is visible from the page;
  everything downstream is not, which is what `PACE_MS` is actually for.
- **To debug anything in the overlay, attach devtools**: start OBS with
  `--remote-debugging-port=9222` and open `http://localhost:9222` in Chrome. A browser source
  has no visible console otherwise, which is why `createImageReceiver` logs whether a set was
  applied or dropped and with what count.
- **`ws://` from an `https://` page works here and only here.** Loopback is a potentially
  trustworthy origin, so `ws://127.0.0.1:4455` is exempt from mixed-content blocking. Point it
  at a LAN address and the browser blocks it before it is sent. `normalizeObs` deliberately
  does not enforce loopback — a `wss://` OBS elsewhere is legitimate — so the error message is
  what has to explain it.
- **`emit_event` is a broadcast to every browser source in OBS**, hence the namespaced
  `OBS_EVENT_NAME`. A source that is not the overlay receives an event it has never heard of.
- **The push is delayed ~2 s after Identified.** OBS brings its WebSocket server up around the
  same time as it loads the scene collection, not reliably after it, and a push that wins that
  race is dispatched at a source with no listener attached yet — unrecoverable, per the
  one-way rule.
- A wrong password or an unusable URL **latches `fatal`** and stops the retry loop. Without it
  the effect in `useObsBridge` re-dials on every navigation between the two screens that use it.
- `useObsBridge` is called by the dashboard and the config screen, **never by `/avatar`** — an
  overlay has nothing to push, and one inside OBS would be dialling the OBS that renders it.
  Like `bot.ts`, the bridge is a module singleton and is deliberately **not** disconnected on
  unmount.
- `components/ObsGuide.tsx` is the setup walkthrough behind "How do I set this up?", and it
  leads with *why* rather than the steps: every step happens in another program, and the
  payoff is invisible until it already works, so a streamer with no reason to paste a password
  into a text field will reasonably decline. Its screenshots are the **first and only thing in
  `public/`** — which the Dockerfile now copies explicitly, because `output: "standalone"`
  omits `public/` exactly the way it omits `.next/static`. That failure mode is invisible in
  `npm run dev` and a 404 in the container.
- The bridge is the **first** section on `/avatar-config`, above the images and the effects,
  and the dashboard's "Open avatar view" goes through
  `dashboard/AvatarWindowNotice.tsx` before it opens anything: the throttling above is
  invisible while setting up and only shows itself mid-stream, so both screens say it before
  a streamer commits to the window. The notice's useful action is the route to
  `/avatar-config`, not the cancel, which is why it is its own dialog rather than
  `ConfirmDialog`. `ObsGuide`'s last step says *further down this page* for the same reason —
  the background panel is now below the bridge, not above it.
- The screenshots are redacted copies. OBS's Connect Info panel shows the WebSocket password
  in clear **and encodes it again in the Connect QR beside it** — both are painted out. The
  originals are the two PNGs in this directory's root; regenerate from those, not from
  `public/`, and redact both spots again.

### Storage

| What | Where |
| --- | --- |
| Settings + auth token | `localStorage` `moneybot.settings.v1` |
| Per-chatter voices | `localStorage` `moneybot.uservoices.v1` (own key so a settings rewrite can't clobber it) |
| Bits read today | `localStorage` `moneybot.bitsToday.v1`, keyed by date |
| Avatar images | IndexedDB `moneybot-avatar` (up to 4 MB each; would blow the localStorage budget) |
| Avatar images, again | the same store in **OBS's** CEF profile, written by the overlay from what the bridge pushed. A cache, not a source of truth — `cacheAvatar` writes it without the config-changed ping, which in that profile would only come back to the overlay that just wrote it |
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
| `/` | public landing page (handoff screen `2a`) — see below |
| `/login` | Twitch OAuth, or channel + pasted token |
| `/setup` | triggers and audio preferences |
| `/dashboard` | queue, chat, controls |
| `/avatar-config` | idle image, talking frames, fps, background, crossfade / caption / bob, the OBS connection |
| `/avatar` | OBS browser source, transparent background |
| `/auth/callback` | reads the OAuth fragment and `postMessage`s it to the opener |

`window.__moneybot` exposes the runtime in development builds only.

### The landing page

`/` was an entry router — a spinner that read `localStorage` and replaced itself with
`/login`, `/setup` or `/dashboard`. The handoff's navigation rule now starts a step earlier
("home page → login → …"), so it is a real page: the URL a streamer gets sent in chat, which
has to explain the app to somebody who has never heard of it.

- **The redirect is gone, on purpose.** Sending a signed-in visitor straight to `/dashboard`
  was the obvious alternative and makes the landing page unreachable for exactly the person
  most likely to want to link it. What survives is the *destination*: both "Sign in with
  Twitch" buttons become "Open dashboard" / "Finish setup" once a token exists, so a returning
  streamer is still one click away. `signedIn` is false pre-hydration, which is correct — the
  server render is what a first-time visitor sees.
- **"Play preview" plays the app's real voices, pre-rendered — it does not synthesise.** The
  handoff specified `speechSynthesis`, which would mean demonstrating the app with whatever
  voice the visitor's OS ships, i.e. the thing this app replaces. Synthesising for real in the
  page is worse in both builds: the browser engine would pull 86 MB of weights before an
  unsigned-in visitor heard anything, and the server engine would point a public page at the
  Kokoro relay. So `tools/build-samples.py` renders the line once from `../server` into
  `public/samples/<voice>.mp3` — one ~40 KB clip per English voice, fetched on click.
  - `src/lib/previewSamples.ts` is **generated by that same script** and must not be
    hand-edited: the audio and the list have to move together, which is why one script writes
    both. Re-run it to change the line, add a voice or retire one.
  - The line is the bot's own cheer phrasing (`${displayName} cheered ${bits} bits: ${body}`,
    from `handleChat`), so the page's claim to read it "the way your viewers will" is literal.
    The one departure is spelling `coin_gremlin` without the underscore — espeak pronounces
    punctuation inside a word.
  - **`af_nicole` is excluded by request**, hence 27 clips rather than 28. The exclusion lives
    in the generator's `EXCLUDE`.
  - The voice is re-rolled every press and never repeats back to back — a second press
    demonstrating the range is the entire reason for using the real engine here. Which voice
    it landed on is deliberately **not** labelled: a line that exists only while playing
    reflows the card under the button the visitor just pressed.
  - **The muted play-then-pause in `useCheerPreview` is load-bearing.** The chime leads by
    ~420 ms, and a `play()` that first happens inside that timer has lost the user gesture, so
    iOS Safari refuses it. Unlocking the element inside the click is what buys the delay; the
    mute is so the unlock makes no sound. A watchdog bounds the talking state either way — the
    button must never be a dead control.
- **Wormo (`public/avatar-{idle,talk}.png`) is shipped art, not a placeholder** — the first
  real assets the handoff has carried. They are downscaled to 300×371 from the 700×866
  originals in `design_handoff_moneybot_tts/design/assets/`; regenerate from those. Like the
  OBS screenshots they live in `public/`, which `output: "standalone"` omits and the
  Dockerfile copies explicitly.
- The **login screen also changed in that handoff revision** (Twitch OAuth only, the manual
  channel + token form removed, a three-item reassurance list in its place). That was left
  alone by request — this pass was the homepage and nothing else.

## Design handoff

`design_handoff_moneybot_tts/` is **reference material, not source** — a static HTML
prototype of the six designed screens (`2a` home, then `1a`–`1e`). It is excluded from
`tsconfig.json` and from Next's file tracing, and `support.js` in there is the prototype's own
runtime, to be ignored. Its `design/assets/` is the one exception to "not source": the two
Wormo PNGs there are real artwork, and `public/avatar-*.png` are downscales of them.

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

**Run both after every change, as the last step of the change.** Independent stacks is the
useful property here and also the trap: almost everything in this tree is shared (everything
above `src/lib/ttsClient.ts`), so an edit belongs in both containers, but nothing rebuilds the
other one for you — `up` on one is silently a no-op for the other, and the stack you forgot
keeps serving the old bundle until someone notices on a stream. There is no dev server running
against either, and the host's `node` is v10, so a rebuild is also the only way the change gets
executed at all. Nothing here is hot-reloaded: `basePath`, the engine and the Twitch client ID
are baked in at build time, so `--build` is not optional and `restart` does nothing.

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
