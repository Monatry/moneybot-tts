# Handoff: Moneybot TTS, web app UI

## Overview
Moneybot TTS is a browser-based control panel for a Twitch text-to-speech bot. A streamer logs in, connects their channel, chooses which Twitch events get read aloud (chat messages, cheers, channel-point redeems), then runs the bot from a dashboard that shows the speech queue and live chat side by side. A separate browser-source "avatar view" (an idle image that swaps to cycling talking frames while speech plays) is configured from its own screen.

Six screens are designed:
0. Home page (public landing, with a playable TTS preview)
1. Login
2. Setup step 1 of 2, connect channel
3. Setup step 2 of 2, triggers and audio
4. Main dashboard: queue, chat, controls
5. Avatar configuration

## About the Design Files
The files in `design/` are **design references authored in HTML**, a prototype board showing intended look, layout and copy. They are **not production code to lift**. The task is to **recreate these designs in the target codebase's own environment** (React, Vue, Svelte, Electron, etc.) using its established patterns, component library and state conventions. If no codebase exists yet, pick an appropriate stack (a Vite + React SPA talking to Twitch IRC/EventSub over a small local server is a natural fit for this app) and implement the designs there.

`design/Moneybot TTS.dc.html` is a single HTML file containing all screens laid out on one canvas. The top section holds the home page, labelled `2a`; the section below holds the app flow, labelled `1a` to `1e`. Open it in a browser to see them. The home page's "Play preview" button really works: it plays a short chime, speaks the sample cheer through the Web Speech API, and cycles the avatar frames while speech is playing. Styling is inline; a design-system stylesheet (`design/_ds/organic-…/styles.css`) supplies fonts, tokens and the `.btn` / `.input` / `.tag` / `.card` / `.nav` / `.seg` classes. `support.js` is the prototype's own runtime, ignore it entirely when implementing.

## Fidelity
**High-fidelity.** Colors, type, spacing, radii and copy are final. Recreate the UI faithfully using the target codebase's libraries. The only intentionally unfinished piece is the avatar view itself (the browser-source overlay), which was not designed, only its configuration screen.

Note: the mocks are static. Interactive controls (sliders, toggles, dropdowns, file pickers) are drawn in their resting states and must be implemented as real controls.

---

## Design Tokens

### Colors
The theme is **white and gold dominant, Twitch purple for accents**, on a warm-neutral base.

| Role | Value | Use |
| --- | --- | --- |
| Page white | `#ffffff` | primary app surface |
| Warm surface | `#fffcf2` | panels, sidebars, inset areas |
| Canvas / board | `#f3efe4` | outside the app frame (prototype only) |
| Text | `#1b1815` | body and headings |
| Text muted | `rgba(27,24,21,.55)` – `.6` | secondary copy |
| Text faint | `rgba(27,24,21,.45)` | meta, hints |
| Divider | `rgba(27,24,21,.09)` – `.12` | borders, rules |
| Gold 100 | `#fdf7e2` | tinted fills, cheer highlights |
| Gold 200 | `#f7e9b9` | tint, chips |
| Gold 300 | `#efd582` | borders on gold cards |
| Gold 400 | `#dfbc4c` | mid |
| **Gold 500 (accent)** | `#c8a02a` | primary buttons, active toggles, slider fill |
| Gold 600 | `#a5811b` | hover / pressed, drop shadow on coin |
| Gold 700 | `#806214` | accent-colored small text, links |
| Gold 800 | `#5b450f` | text on gold tints |
| Gold 900 | `#3a2c0a` | strongest gold text |
| Purple 100 | `#f4edff` | Twitch-related tint panels |
| Purple 200 | `#e5d6ff` | redeem chips |
| Purple 300 | `#cbb0ff` | borders on redeem cards |
| **Purple 500 (Twitch)** | `#9146ff` | Twitch actions, redeem toggle, "Test speak" |
| Purple 600 | `#7a2ff0` | hover |
| Purple 700 | `#5f22bd` | purple body text |
| Purple 800 | `#421785` | text on purple tints |
| Purple 900 | `#2a0f55` | strongest purple text |
| Sage | `#7a8a5e` / text `#56633f` | success dots ("channel found") |
| Danger | `#8c1d1d` | "Clear queue", delete ✕ |
| Chat name colors | `#5f22bd`, `#0f7b6c`, `#a5811b`, `#b3355a`, `#5f7b0f` | per-user chat name tints |

Primary button = gold `#c8a02a` fill with **dark** label `#241f14` (white on gold fails contrast, keep the dark label).

### Typography
- Display/heading: **Caprasimo** 400 (`--font-heading`), line-height 1.12, letter-spacing −0.015em.
- Body/UI: **Figtree** 400/600/700 (`--font-body`), base 15px / line-height 1.55.
- Both loaded from Google Fonts by the design-system stylesheet.
- Scale in use: h1 62px (login hero) · h2 32px (screen titles) · h3 25px · h4 20px (panel titles) · h6 13px uppercase, letter-spacing .08em (section eyebrows).
- Body sizes: 15px default, 14.5px card titles (bold 700), 13.5px chat lines and list rows, 12.5px hints, 12px meta, 11px uppercase micro-labels (letter-spacing .1em).
- Buttons use the heading font at 14px (design-system `.btn`); larger CTAs 15–16px.
- Numeric values (bit counts, fps, volume) are set in the heading font, a deliberate "ticker" feel.

### Radii
`8px` small · `16px` medium · `20–22px` list rows · `26–30px` panels and cards · `999px` pills (all buttons, inputs, tags, toggles). Nothing in this UI has sharp corners.

### Spacing
4.4 / 8.8 / 13.2 / 17.6 / 26.4 / 35.2 px scale (design-system `--space-*`). In practice: 10–14px inside rows, 18–26px panel padding, 22–36px screen padding, 24px grid gaps.

### Shadows
- `0 2px 8px rgba(30,25,10,.06)`, resting control bars.
- `0 3px 0 <gold-600>`, the coin mark's solid "stacked" shadow.
- `0 6px 0 #a5811b`, large avatar coin preview.
- `0 10px 34px rgba(30,25,10,.13)`, screen frames on the board (prototype chrome only).

### Icons
Design system calls for **Lucide** icons at stroke-width 2.75. The mocks use text glyphs as placeholders (`⚙`, `❚❚`, `🔈`, `💬`, `★`, `✕`, `+`, `−`, `▾`). Replace each with the Lucide equivalent: `settings`, `pause`, `volume-2`, `message-square`, `star`, `x`, `plus`, `minus`, `chevron-down`, plus `skip-forward` for Skip and `trash-2` for Clear queue.

---

## Screens / Views

### 0. Home page (`2a`)
**Purpose:** the public landing page. Explain in seconds what the app does, prove it with a playable preview, explain the name, and push to Twitch sign-in.

**Layout:** 1240px wide, height driven by content (roughly 1500px). White ground with one decorative 620px gold radial circle bleeding off the top-right (`right:-220px; top:-180px`, `radial-gradient(circle at 35% 35%, #fdf7e2, #f7e9b9 62%, #f1dd9d)`, pointer-events none). Four stacked bands:

**a. Brand row** (26/44px padding, flex): 34px gold coin + "Moneybot TTS" in the heading font at 20px; right-aligned purple 42px "Sign in with Twitch". Deliberately not a nav, there are no menu links.

**b. Hero** (34/44px padding, grid `1fr / 520px`, 44px gap, items start):
- Left: purple tag "For Twitch streamers"; h1 66px, line-height 1, max-width 12ch, two lines: "Chat pays," / "Wormo says." (Wormo is the avatar's name; if the product ships a different default avatar, this line changes with it.) Then 19px body, max-width 44ch: "Moneybot reads your Twitch chat out loud. Pick what earns a voice: every message, cheers over a threshold, or a channel-point redeem. Then messages queue up, get spoken on stream, and animate an avatar you drop straight into OBS." Then a 54px purple "Sign in with Twitch" button beside 13px faint reassurance copy, max-width 22ch: "Your Twitch login stays in your own browser. No token ever reaches our server."
- Below that, a 3-column 14px-gap row of numbered explainer cards (radius 26px, `#fffcf2`, 20px pad; borders neutral / `#efd582` / `#cbb0ff`), each a 34px tinted icon circle, a bold 14.5px title and 13px muted body: "1 · Choose the triggers" (All chat, cheers above your minimum, or one channel-point reward) · "2 · Moneybot queues it" (Skip, clear or mute from one dashboard. Big cheers go first) · "3 · Your avatar talks" (Add a browser source in OBS and it lip-syncs to every message).
- Right column, two stacked cards, 16px gap:
  - **Chat demo card** (white, radius 30px, `0 14px 40px rgba(30,25,10,.14)`): header strip on `#fffcf2` with a purple dot, "Stream chat", "312 viewers" and a purple "Live demo" pill; then 5 chat lines at 13.5px, of which the 50-bit cheer sits in a gold `#fdf7e2` card (radius 18px, `#efd582` border, 30px "50" badge, 11px eyebrow "cheered 50 bits · will be read aloud") and the redeem sits in a purple `#f4edff` card (`#cbb0ff` border, star badge, eyebrow "redeemed Make Moneybot Speak"); footer strip on `#fffcf2` with a gold 46px **"Play preview"** button (▶ icon; label toggles to "Stop preview" while playing) and 12.5px caption "Hear the 50-bit cheer read aloud, the way your viewers will."
  - **Avatar card** (`#fffcf2`, radius 30px, 18/20px pad, flex, 20px gap): a 132×150px stage on the left holding the avatar image, and on the right a 10.5px uppercase gold eyebrow "Avatar overlay", a 17px heading-font line "Bring your own art: idle frame, talking frames, done.", 12.5px body "Transparent PNGs at any size. Add as many talking frames as you want, set the cycling speed frame by frame, swap the whole set between streams, and preview it all before it goes live.", then four small tags: "Unlimited frames", "Adjustable speed" (gold), "PNG or GIF", "OBS browser source" (neutral). No button here on purpose.

**c. Audience strip** (0/44px margins, 2-column grid, 18px gap): two white cards (radius 30px, 24/26px pad; second bordered `#cbb0ff`), each an uppercase 10.5px eyebrow, a 19px heading-font question and 13.5px muted answer:
- "YOU ARE IN CHAT" / "Has your favourite small streamer not read a message in ten minutes?" / "Tell them about this app. Free, five minutes to set up, and they never miss you again."
- "YOU ARE THE STREAMER" (purple eyebrow) / "Does chat riot the second you stop looking at it?" / "This app is for you. Keep playing, Moneybot keeps reading, and nobody feels ignored."

**d. About-the-name band** (`#fdf7e2`, `#efd582` border, radius 34px, 30/36px pad, grid `1.25fr / 1fr`, 40px gap):
- Left: eyebrow "ABOUT THE NAME", h3 `#3a2c0a` "No, it does not want your money.", then two `#5b450f` paragraphs at 14.5px, max-width 56ch: (1) "I am **Monatry** on Twitch, which comes from *monetary*, as in "relating to money". So my bot became Moneybot. That is the whole story." (2) "It can stay free because your device does all the work. The voices, the queue and the avatar all run in your own browser, so there are no servers to pay for, no cut of your bits, and no paid tier waiting behind a door."
- Right: two white pill-cards (radius 24px, 18/20px pad) with a 38px badge each: gold "$0" / "Free forever" / "Every feature, no tiers, no trial clock."; purple "✓" / "Your bits stay yours" / "Cheers are only a trigger. Moneybot never touches revenue."

**Behavior:**
- **Play preview** is the one genuinely interactive element in the mocks and should ship as-is in spirit: on click, play a short two-note chime (WebAudio, 1318Hz then 1760Hz triangle blips, ~0.3s decay each), then after ~420ms speak the sample line ("Coin gremlin cheered fifty bits: please tell chat what happened to the sandwich") via `speechSynthesis` at rate 1.05. While speech is playing, the avatar plays its talking animation; on `onend`/`onerror` (or a 9s watchdog) it returns to idle. Clicking again cancels and stops. If `speechSynthesis` is unavailable, still animate for ~3.6s so the button is never dead. A prerecorded audio file is an equally good implementation.
- **Avatar animation:** idle state shows the idle PNG; talking state cross-swaps idle and talking PNGs on a 0.22s `steps(1,end)` cycle (two complementary keyframe tracks at 50% opacity flip), with the whole figure on a 0.5s ±1.5deg / -4px wiggle and an expanding gold ring behind it (`scale(.9)→1.5`, opacity .55→0, 1.1s).
- Both "Sign in with Twitch" buttons start the same OAuth flow. There is no third CTA and no footer nav by design.
- Responsive: below ~1000px stack the hero to one column with the chat demo card under the copy.

### 1. Login (`1a`)
**Purpose:** authenticate with Twitch. **Twitch OAuth is the only path**, the earlier manual channel + token form has been removed deliberately and must not be reintroduced.

**Layout:** full-bleed two-column grid, `1fr / 470px`. Left = white marketing panel with two decorative gold circles bleeding off-canvas (a 520px radial-gradient circle top-left at `-160px,-160px`; a 420px `#faf4e2` circle bottom, left 120px). Right = `#fffcf2` sign-in panel with a 1px left divider, 56/48px padding, vertically centered stack, 22px gaps.

**Left column** (56px top / 64px sides):
- Brand lockup, top: 46px gold coin (radial gradient `#f0d888 → #c8a02a`, `0 3px 0 #a5811b`) with a Caprasimo `$` in `#5b450f`, then "Moneybot TTS" 22px heading.
- Hero (bottom-anchored): h1 62px, two lines, "Let the chat / talk back."
- Body 17px muted, max-width 420px: "Read out chat, cheers and channel-point redeems in one tidy voice queue, with an avatar that moves while it speaks."
- Three pills (`.tag`): "Cheers → speech" (gold tint), "Channel points" (purple tint), "Avatar overlay" (neutral).
- Footer meta 12px faint: "Status: all systems live · v2.4".

**Right column:**
- h3 "Sign in" + 13.5px muted "Moneybot only ever reads your chat, it never posts as you."
- Primary and only CTA: purple `#9146ff`, white label, 52px tall, 16px, with the Twitch glyph left: "Continue with Twitch".
- Below it, a 12px-gap reassurance list, each row a 20px gold-tint check circle plus 13.5px muted text: "Reads chat, cheers and channel points" · "Never posts, follows or subscribes as you" · "Setup takes about a minute".
- Footer 12px: "Trouble signing in? **Read the setup guide**" (link, gold 700).

**Behavior:** the Twitch button starts the OAuth implicit/device flow in a popup; on success go to setup step 1 with the channel prefilled. Failure shows an inline error in `#8c1d1d` under the button with a retry. No manual-credential fallback.

### 2. Setup, step 1 of 2: connect channel (`1b`)
**Purpose:** capture channel name + OAuth token; explain the token.

**Layout:** 64px top nav (brand left, "First-time setup" right, 1px bottom divider) over a `300px / 1fr` grid.

**Left rail** (`#fffcf2`, 1px right divider, 40/30px padding, 26px gaps):
- h6 "SETUP" faint.
- Step 1, active: 30px gold `#c8a02a` circle, white numeral (heading font) + "Connect channel" bold 14px / "Channel name and token" 12.5px muted.
- 1px × 24px vertical connector, indented 14px.
- Step 2, `opacity:.5`: 30px circle outlined `1.5px rgba(27,24,21,.3)` + "Preferences" / "Triggers and audio".
- Bottom-anchored purple note card (`#f4edff`, radius 20px, 16px pad): title "Why a token?" `#421785` bold 13px, body `#5f22bd` 12.5px: "Moneybot reads chat over IRC. The token is stored locally in your browser only."

**Main column** (52/64px padding, max-width 760px, 28px gaps):
- h2 "Connect your channel" + 15px muted "Two fields and you're reading chat."
- **Channel field** (max-width 420px): 48px pill container `#fffcf2`, 1px divider border, 16px inline padding, holding a static `twitch.tv/` prefix in faint 14px, a borderless 15px input (`moneybot_demo`), and an 8px sage dot `#7a8a5e` with a `0 0 0 4px rgba(122,138,94,.18)` halo. Below: 12px `#56633f` "Channel found · 1.2k followers".
- **OAuth field** (max-width 620px): 48px pill input (masked token, letter-spacing .05em) beside a purple 48px "Request token" button. Hint 12px: "Opens Twitch in a new tab and pastes the token back automatically."
- **Scope note:** gold `#fdf7e2` pill panel radius 24px, 16/20px pad, 26px gold coin + `#5b450f` 13.5px: "Cheers and redeems need moderator scope, the request button asks for it."
- Bottom actions: gold primary 48px "Continue" + ghost "Skip for now" (`#806214`).

**Behavior:** channel name debounce-validated against Helix (`/users`), success shows the sage dot and follower line, failure shows a red inline message and disables Continue. "Request token" opens the Twitch auth URL with `chat:read`, `bits:read`, `channel:read:redemptions`; the redirect page posts the token back and the field fills automatically. Token field masks input but allows paste. "Skip for now" jumps to step 2 with a warning banner that TTS stays offline until a token exists.

### 3. Setup, step 2 of 2: triggers & audio (`1c`)
**Purpose:** choose event triggers and audio output.

**Layout:** same nav ("Step 2 of 2 · Preferences"). Body 34/44px padding, 22px gaps. Header row: h2 "What should Moneybot read?" + 14.5px muted "You can change all of this later from the dashboard." on the left; on the right a 2-segment progress indicator (two 34×5px gold pills). Below: two-panel grid `1.15fr / 1fr`, 24px gap, both panels `#fffcf2`, 1px divider border, radius 30px, 26/28px padding.

**Left panel, "Triggers"** (h4, then 12px-gapped rows on white, radius 22px, 16/18px pad):
1. **Chat messages**, bold 14.5px title, 12.5px muted "Every message from everyone in chat", gold toggle ON right.
2. **Cheers**, border `#efd582`. Title + "Bits messages, loudest first", gold toggle ON. Below a 1px dashed divider: label "Minimum bits" 13px, then a 38px pill stepper (`#fffcf2`) showing the value in heading font 16px with 26px round `−`/`+` buttons in `#f7e9b9`/`#5b450f`, then faint 12px "and above get read". Default 50.
3. **Channel points**, border `#cbb0ff`. Title + "One redeem drives the queue", **purple** toggle ON. Below dashed divider: "Redeem name" label + 38px pill input, value "Make Moneybot Speak".

**Right panel, "Audio"** (h4, 18px gaps):
- "Output device": 44px white pill row, 14px value "VoiceMeeter Input (VB-Audio)" + chevron right, a select populated from `navigator.mediaDevices.enumerateDevices()`.
- "Playback speed": 8px track `#f0e6cd`, filled 56% with `linear-gradient(90deg,#efd582,#c8a02a)`, 22px white knob with 2px gold border and `0 2px 5px rgba(30,25,10,.2)`; value "1.15×" right, heading font 16px, min-width 44px. Range 0.5–2.0, step 0.05.
- "Minimum delay between messages": design-system `.seg` segmented control, options `0s / 0.5s / 1s / 2s`, `0.5s` selected (selected option = gold fill, white text).
- Bottom **test card**: white, 1px dashed border, radius 24px, 20px pad, an 8-bar gold waveform (heights 38/72/100/64/88/30/54/22%, 4px gap, pill bars, alternating `#f7e9b9`/`#efd582`/`#c8a02a`), then a row with 12.5px muted caption "“Moneybot is ready to read your chat.”" and a secondary 40px "Test audio" button.
- Footer actions: secondary "Back", gold primary "Finish setup" (48px), and right-aligned 12.5px faint "Settings live in your browser, nothing leaves this machine."

**Behavior:** toggling a trigger off collapses/disables its sub-controls (dim to 45%, per design-system disabled state). Minimum bits clamps 0–100000. Redeem name should ideally be a picker of the channel's existing rewards, falling back to free text. "Test audio" speaks the caption line through the selected device at the current speed and animates the waveform bars. "Finish setup" persists settings locally and routes to the dashboard.

### 4. Main dashboard (`1d`)
**Purpose:** run the bot, watch the queue, moderate it, watch chat, control volume and sources.

**Frame:** 1440 × 860 design size. Top nav 16/28px padding, 1px bottom divider, items left→right: brand lockup (30px coin) · purple status pill `#f4edff` with a purple dot: "Connected to **moneybot_demo**" · gold pill `#fdf7e2`: "**1,480** bits read today" (number in heading font) · then right-aligned: purple 40px "Open avatar view", secondary 40px "Configure avatar", 40px secondary icon button (settings).

**Body:** grid `1.35fr / 1fr`, left control column, right chat column (1px left divider, `#fffcf2`).

**Left column** (24/26px padding, 18px gaps, three stacked blocks):

*a. Now-speaking card*, `linear-gradient(135deg,#fdf7e2,#f7e9b9)`, radius 30px, 22/24px pad, row with 20px gaps:
- 56px white circle, gold `$`, `0 3px 0 #dfbc4c`, gently bouncing (`translateY 0 → −6px`, 1.6s ease-in-out infinite).
- Middle: 10px uppercase `#806214` "NOW SPEAKING" + a purple "1000 bits" chip; then the utterance in the heading font 19px `#3a2c0a`: `pixelpauper: “That last clutch was absolutely criminal, do it again”`; then a 6px progress track `rgba(91,69,15,.16)` filled 42% in `#a5811b`.
- Right: 44px secondary icon button (pause) and a 44px dark `#5b450f` button with cream label "Skip".

*b. Queue panel*, `#fffcf2`, 1px divider border, radius 30px, 20/22px pad, flex column, 14px gap:
- Header: h4 "Queue", neutral tag "6 waiting · 1m 12s", right-aligned 36px white secondary buttons "Skip next" and "Clear queue" (danger-tinted: text `#8c1d1d`, border `rgba(140,29,29,.25)`).
- Rows (white, radius 20px, 12/16px pad, 9px gap, 14px internal gap): index in heading font 13px `#a5811b` (18px wide) · 30px source badge circle (gold tint with the bit amount for cheers, purple tint with a star for redeems, neutral with a chat glyph for chat) · name bold 13.5px over the message 13px muted, single-line ellipsis · source tag (`Cheer` gold / `Redeem` purple / `Chat` neutral) · duration 12px faint, 34px right-aligned · a faint ✕ remove control. Cheer rows border `#efd582`, redeem rows `#cbb0ff`, chat rows the neutral divider. Rows further down the list fade (`opacity:.72`) to imply scroll.
- Sample content, in order: `coin_gremlin` 50 bits "Please tell chat what happened to the sandwich" 0:06 · `lurkasaurus` redeem "Moneybot, say hi to my cat Miso" 0:04 · `bitwise_barry` chat "the vod timestamp is 1:42:07 for anyone who missed it" 0:08 · `very_liquid` 200 bits "two hundred bits says you can't do it blindfolded" 0:07 · `not_a_mod` chat "chat is being unusually polite today, suspicious" 0:05.

*c. Control bar*, white, 1px divider border, radius 30px, 18/22px pad, 26px gaps, `0 2px 8px rgba(30,25,10,.06)`:
- Left (flex 1): 11px uppercase faint "MASTER VOLUME"; row of speaker icon, an 8px track filled 72% with the gold gradient and the 22px white/gold knob, and the value `72` in heading font 15px.
- 1px × 52px vertical divider.
- Right: 11px uppercase faint "SOURCES" over three pill toggles with a 40×24px switch each, **Chat** (gold ON, `#fdf7e2` pill, `#efd582` border, `#5b450f` label), **Bits** (gold ON, same), **Redeems** (OFF: `#f6f4ee` pill, faint label, `#ddd7c9` switch with the knob left).

**Right column, chat:**
- Header 18/22px, 1px bottom divider: h4 "Twitch chat", 12px muted "312 viewers", right-aligned purple "Live" pill (`#f4edff` / `#5f22bd`).
- Message list 16/22px, 11px gaps, 13.5px / line-height 1.5: plain lines are `**name**: message` with the name bold in its user color and the body `rgba(27,24,21,.75)`. Event messages get a tinted card (radius 16px, 10/12px pad): cheers on `#fdf7e2` with an 11px `#806214` eyebrow "cheered 50 bits"; redeems on `#f4edff` with a `#5f22bd` eyebrow "redeemed Make Moneybot Speak". Bottom of list: a 12px faint "auto-scrolling" indicator with a small gold dot.
- Composer 14/22px, 1px top divider: 42px white pill input placeholder "Send a message as moneybot_demo" + gold 42px "Send".

**Behavior:** queue and chat both stream live (IRC/EventSub) and auto-scroll, pausing auto-scroll when the user scrolls up. Skip stops current playback and advances; "Clear queue" asks for confirmation (design-system dialog) and empties everything but the current utterance. Per-row ✕ removes that item. Volume and source toggles apply instantly and persist. Source toggles do **not** retro-filter what's already queued. "Open avatar view" opens the overlay route in a new window (also the URL a streamer copies into OBS); "Configure avatar" routes to screen 5.

### 5. Avatar configuration (`1e`)
**Purpose:** upload the idle image and talking frames, set the animation speed, preview both states.

**Layout:** nav (brand · "← Back to dashboard" · right-aligned "Avatar configuration"), then a `1fr / 480px` grid, left form (32/36px padding, 22px gaps), right preview rail (1px left divider, `linear-gradient(180deg,#fffcf2,#fdf7e2)`, 32/34px padding).

**Left:**
- h2 "Avatar" + 14.5px muted "One idle image, one or more talking frames. Moneybot cycles the talking frames while a message is read."
- **Idle image**: h4 + 12.5px muted "shown when the queue is empty". Row of a 150px gold-tint preview tile (radius 26px, border `#efd582`, 66px coin inside, caption "idle.png · 512×512" in 11px `#806214` at the bottom) and a flex-1 dropzone (1.5px dashed `rgba(27,24,21,.2)`, radius 26px, `#fffcf2`): bold 14px "Drop a new image here", 12.5px muted "PNG or GIF with transparency, up to 4 MB", secondary 36px "Choose file".
- **Talking frames**: h4 + 12.5px muted "3 frames · played in order" + right-aligned ghost "Reorder". Then a wrapping 12px-gap row of 118px tiles (gold tint, radius 22px, `#efd582` border) each with a 52px placeholder shape (circle / rounded square / pill, standing in for different mouth positions), a 10.5px `#806214` index label top-left ("01", "02", "03"), and a 20px white round delete ✕ (`#8c1d1d`) top-right; last tile is a dashed "＋ Add frames" slot.
- **Talking animation speed** panel (`#fffcf2`, 1px border, radius 26px, 20/22px pad): bold 14.5px label with the value right ("12 fps", heading font 17px); slider row "Slow", 8px gold track filled 48% with the standard knob, "Fast"; hint 12.5px muted "Each frame holds ~83 ms. Below 6 fps the mouth reads as stuttering." Range 4–24 fps.
- Bottom actions: gold primary 46px "Save avatar", secondary 46px "Reset to default", right-aligned 12px faint "Overlay URL: localhost:4711/avatar".

**Right (preview):**
- h4 "Preview".
- **Idle** block: neutral "Idle" tag + 12px muted "queue empty"; a 200px white stage, radius 26px, with an 18px checkerboard (`#f8f6f0` 45° gradients, offset 9px) to signal transparency, holding a 92px gold coin with `0 6px 0 #a5811b`.
- **Talking** block: gold "Talking" tag + 12px muted "frames cycling at 12 fps"; identical stage where the three frame placeholders are absolutely stacked and cycled, `steps(1,end)` keyframes, one third of the cycle visible each, offsets `0 / .12s / .24s` on a `.36s` loop (i.e. cycle = frames ÷ fps; the mock is 3 frames at ~8.3 fps). Bottom-center: a 4-bar gold mini-waveform (5px wide pill bars, heights 12/20/9/16px).
- Bottom-anchored test card (white, radius 24px, 18/20px pad, soft shadow): 12.5px muted "Play a test line to see the animation with real audio." + purple 40px "Test speak".

**Behavior:** both dropzones accept drag-drop and file-picker input, validate type/size, and store as object URLs / local blobs. Frames are reorderable (drag or the "Reorder" affordance) and individually deletable; deleting all frames should fall back to the idle image with an inline notice. The speed slider re-times the preview live, recompute the animation duration as `frameCount / fps`. "Save avatar" persists and pushes the config to any open avatar view (BroadcastChannel or websocket). The overlay itself is out of scope for this design.

---

## Interactions & Behavior (cross-cutting)
- **Navigation:** home page → login → (first run) setup 1 → setup 2 → dashboard. Returning users land on the dashboard; setup is reachable from the nav settings icon. Avatar config is a sub-route of the dashboard.
- **Toggles/sliders/steppers** apply immediately and persist; there is no explicit Save on the dashboard (only on avatar config).
- **Hover/pressed/focus:** take these from the design system, hover tints one ramp step, pressed one step further (`#a5811b` for gold, `#7a2ff0` for purple), and `:focus-visible { outline: 2px solid <accent>; outline-offset: 2px }`. Never leave default browser focus rings.
- **Animations:** the coin bounce is 1.6s ease-in-out infinite, ±6px. Talking preview uses `steps(1,end)` frame swapping. Queue rows should enter with a short (~150ms) fade/slide; keep motion minimal elsewhere.
- **Loading states:** channel validation shows a spinner in place of the sage dot; device enumeration shows a disabled select reading "Looking for devices…"; the queue's empty state should read as calm (idle coin + "Nothing to read, chat is quiet").
- **Error states:** inline, in `#8c1d1d`, directly under the offending field; connection loss replaces the purple "Connected to …" nav pill with a red "Reconnecting…" pill.
- **Responsive:** designed for desktop (1240–1440px). Below ~1100px stack the dashboard's chat column beneath the control column and let the queue scroll; below ~700px the app is out of scope.

## State Management
- `auth`: `{ channel, token, scopes, status }`.
- `settings.triggers`: `{ chat: bool, cheers: { enabled, minBits }, redeems: { enabled, rewardName } }`.
- `settings.audio`: `{ outputDeviceId, playbackRate, minDelayMs }`, plus `masterVolume`.
- `settings.avatar`: `{ idleImage, talkingFrames[], fps }`.
- `runtime`: `queue[]` (`{ id, user, source, amount?, text, estDurationMs }`), `nowPlaying` (+ progress), `chatLog[]`, `connectionStatus`, `viewerCount`, `bitsReadToday`.
- Transitions: an inbound Twitch event is filtered by `settings.triggers` → enqueued → dequeued by the player, respecting `minDelayMs` and `playbackRate`; while playing, `nowPlaying` drives both the progress bar and the avatar view's talking state.
- Data: Twitch IRC for chat and cheers, EventSub for channel-point redemptions, Helix for channel/reward lookups. Settings persist locally (localStorage or app config); the token must never be sent anywhere but Twitch.

## Assets
`design/assets/avatar-idle.png` and `design/assets/avatar-talk.png` are the real avatar artwork (Wormo, 700×866 transparent PNGs, mouth closed and mouth open). They are used by the home page preview and are production-ready. Everything else in the mocks is CSS-drawn:
- The `$` coin mark (gradient circle + Caprasimo `$`) is a **placeholder logo**, replace with the real brand mark when there is one.
- Avatar idle/talking tiles are **placeholders** for user-uploaded images.
- Icons are text-glyph placeholders → use Lucide (see Design Tokens → Icons).
- Fonts (Caprasimo, Figtree) come from Google Fonts.

## Files
- `design/Moneybot TTS.dc.html`, all screens on one canvas (`2a` home page, `1a` login, `1b` setup 1, `1c` setup 2, `1d` dashboard, `1e` avatar config). Open in a browser.
- `design/assets/avatar-idle.png`, `design/assets/avatar-talk.png`, the avatar frames used by the home-page preview.
- `design/_ds/organic-3a899c6e-ac03-45ad-9d2d-90e65b27ba05/styles.css`, design-system tokens and component classes (the mock overrides its palette to white/gold/purple in the file's `<style>` block, that override is the real palette; see the token table above).
- `design/_ds/organic-3a899c6e-ac03-45ad-9d2d-90e65b27ba05/readme.md`, design-system guidance (rounded, warm, left-aligned, Caprasimo + Figtree).
- `design/support.js`, `design/_ds/.../_ds_bundle.js`, prototype runtime only; **do not port**.
