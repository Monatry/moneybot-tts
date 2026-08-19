"use client";

/**
 * The overlay running the bot itself.
 *
 * Activating TTS used to cost exactly one thing: opening /dashboard in a browser and leaving
 * it there, because that page is the only place the runtime ever started. Everything else was
 * already automatic — the overlay is a browser source, so OBS brings it up on its own. This
 * module closes the gap: when no dashboard is running, the overlay *is* the client. Starting
 * OBS starts the TTS, and a streamer who set this up months ago has nothing to change.
 *
 * Three things make that possible, and each is somewhere else:
 *
 * - **The setup travels.** CEF is its own browser profile, so the overlay cannot read the
 *   dashboard's localStorage. The bridge already carries the avatar and its images; it now
 *   carries the whole settings object too (`setup` in lib/avatarStore.ts), and this module
 *   writes it into the overlay's own store so a restarted OBS is configured before any
 *   dashboard reconnects.
 * - **Synthesis is server-side, always, here.** OBS's CEF has no WebGPU and its WASM
 *   throughput is far too low to synthesise a chat message in time, so a browser-engine build
 *   would be unusable in a browser source. `forceEngine("server")` points this page at
 *   /api/tts/* instead — the code path the private build uses, which ships in both images.
 *   The overlay therefore never downloads Kokoro's weights, never builds an ONNX session and
 *   never runs inference; OBS just plays PCM.
 * - **Exactly one client speaks.** Two would mean two IRC connections and two EventSub
 *   sessions, i.e. everything read twice. lib/runnerLease.ts holds a Web Lock for the pages
 *   that share a browser profile; the `bot-alive` heartbeat below covers the one pair that
 *   cannot share one.
 *
 * **It only volunteers inside OBS** (or with `?run=1`, which is how you test it in a normal
 * browser). An overlay opened in a browser window stays the passive display it has always
 * been — partly to keep that flow unchanged, and partly because a browser source is the one
 * place a page gets to start an AudioContext with no user gesture. See the watchdog below for
 * what happens when that assumption is wrong.
 */

import { getBot, CLIENT_ID } from "./bot";
import { isInsideObs, subscribeAvatarMessages, type AvatarMessage } from "./avatarStore";
import { claimRunnerLease, type RunnerLease } from "./runnerLease";
import { settingsStore, type Settings } from "./settings";
import { forceEngine } from "./ttsEngine";

/**
 * How long to listen before volunteering, on a page that has heard nothing yet.
 *
 * This is the whole of the delay between OBS opening and chat being read, so it wants to be as
 * short as it can safely be. What it has to be long enough for is one thing only: hearing a
 * dashboard that is *already* running. Such a dashboard beats every `HEARTBEAT_MS` regardless of
 * what its queue is doing, so one interval plus margin is the real bound — there is nothing else
 * to wait for, and in particular not the bridge's connect-and-push sequence, which is about
 * delivering images and has no bearing on whether somebody else is the client.
 *
 * Volunteering early is also the cheap mistake of the two. If a dashboard does turn up a moment
 * later it says so, and this page stands down after the line in flight; whereas every second
 * spent waiting here is a second of chat nobody hears, on every single stream.
 */
const STARTUP_GRACE_MS = 4000;

/**
 * How long a silence from a client we *have* been hearing means it is gone.
 *
 * Deliberately much longer than the grace above, and for the opposite reason: by this point the
 * question is not "is anyone there" but "has the one I can hear stopped", and a dropped vendor
 * event or a stalled frame must not read as a closed dashboard. Taking over wrongly here would
 * mean two clients on a stream that is already running, which is worse than reacting slowly.
 */
const YIELD_TIMEOUT_MS = 10_000;

/**
 * How often the decision is re-made. Adds its own granularity on top of the grace above, which
 * is the only reason it is not simply a second.
 */
const TICK_MS = 500;

/** Cap on waiting for the current line to finish before yielding to a dashboard. */
const YIELD_LINE_CAP_MS = 15_000;

/** How long a message may be playing with a dead audio context before we say so. */
const AUDIO_WATCHDOG_MS = 5000;

/**
 * How long the "connected" line is kept before it is dropped.
 *
 * Must outlast the CSS that fades it (5 s still, then a 3 s fade — see overlay.module.css), or
 * React unmounts the element part-way through and the line disappears instead of fading. The
 * margin is for that ordering, not for taste.
 */
const OK_LINGER_MS = 8300;

/**
 * How long a one-off synthesis failure stays on screen before being dismissed.
 *
 * `BotState.lastError` is sticky — on the dashboard a human clicks it away, and there is nobody
 * to do that here, so a single failed message would otherwise leave a line on the stream for
 * the rest of the night. Dismissing it means a *recurring* fault re-raises it within seconds
 * and so stays visible, while a blip clears itself. That is the distinction worth drawing.
 */
const ERROR_LINGER_MS = 20_000;

export interface RunnerStatus {
  tone: "info" | "ok" | "error";
  text: string;
  /** A line that fades out on its own; the runner clears it once the fade has run. */
  transient: boolean;
}

type Phase = "passive" | "waiting" | "starting" | "running";

let lease: RunnerLease | null = null;
let dashboardLease: RunnerLease | null = null;
let unsubscribe: (() => void) | null = null;
let unsubscribeBot: (() => void) | null = null;
let ticker: number | null = null;
let okTimer: number | null = null;

let phase: Phase = "passive";
let status: RunnerStatus | null = null;
const listeners = new Set<() => void>();

/** When another client last said it was running. 0 means "never heard one". */
let lastForeignBeat = 0;
let startedAt = 0;
/** Set while standing down: waiting for the line in flight to finish. */
let yieldingSince = 0;
/** When audio was first found to be playing into a context that is not running. */
let deafSince = 0;
/**
 * Bumped by every take-over and every stand-down, so a `start()` that is still awaiting can
 * tell it has been overtaken. `bot.start()` loads the voice list first, which is a network
 * round trip — long enough for a dashboard to appear and for this page to be told to stop,
 * and without this the continuation would then mark itself running with the bot stopped.
 */
let runGeneration = 0;
/** When the currently displayed `lastError` was first shown. */
let errorShownAt = 0;
/**
 * Whether the "reading chat" line has already had its turn this run.
 *
 * `evaluateStatus` re-runs every tick, so without this the success line would be re-raised one
 * second after fading out, forever. Cleared by anything unhealthy, which is what makes a
 * recovery announce itself again instead of going quietly.
 */
let okAnnounced = false;

export function getRunnerStatus(): RunnerStatus | null {
  return status;
}

export function getRunnerServerStatus(): RunnerStatus | null {
  return null;
}

export function subscribeRunnerStatus(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function setStatus(next: RunnerStatus | null) {
  const same =
    status === next ||
    (status !== null &&
      next !== null &&
      status.tone === next.tone &&
      status.text === next.text &&
      status.transient === next.transient);
  if (same) return;
  status = next;
  if (okTimer !== null) {
    window.clearTimeout(okTimer);
    okTimer = null;
  }
  // A transient line clears itself. The fade is CSS on the way out, so this only has to
  // outlast the animation — see overlay.module.css.
  if (next?.transient) {
    okTimer = window.setTimeout(() => {
      okTimer = null;
      setStatus(null);
    }, OK_LINGER_MS);
  }
  for (const l of listeners) l();
}

/** True when this page is allowed to volunteer at all. */
function wantsToRun(): boolean {
  if (typeof window === "undefined") return false;
  const flag = new URLSearchParams(window.location.search).get("run");
  if (flag === "0") return false;
  return isInsideObs() || flag === "1";
}

/**
 * Starts watching. Idempotent, and a no-op on a page that is not allowed to volunteer, so the
 * overlay can call it unconditionally.
 */
export function startAvatarRunner(): void {
  if (!wantsToRun() || ticker !== null) return;

  startedAt = Date.now();

  // Before anything can synthesise. kokoro-js would be loaded lazily on the first voice
  // list, so this only has to beat `bot.start()` — but there is no reason to leave it late.
  forceEngine("server");

  unsubscribe = subscribeAvatarMessages(onMessage);

  const bot = getBot();
  unsubscribeBot = bot.subscribe(() => evaluateStatus());

  lease = claimRunnerLease({
    onAcquired: () => decide(),
    onStolen: () => {
      // Somebody in this profile deliberately took the role — a dashboard starting up. Stop
      // promptly; unlike the heartbeat case there is no doubt about it.
      void standDown(true);
    },
  });

  // The escape hatch for the paragraph above. A browser source normally needs no gesture, but
  // if this CEF ever does, OBS can still supply one: right-click the source, Interact, click.
  // The same two listeners the dashboard carries, for the same reason, and they are what makes
  // `?run=1` in an ordinary browser usable at all.
  const unlock = () => void getBot().player.unlock();
  document.addEventListener("pointerdown", unlock);
  document.addEventListener("keydown", unlock);

  ticker = window.setInterval(decide, TICK_MS);
  decide();
}

export function stopAvatarRunner(): void {
  if (ticker !== null) {
    window.clearInterval(ticker);
    ticker = null;
  }
  unsubscribe?.();
  unsubscribe = null;
  unsubscribeBot?.();
  unsubscribeBot = null;
  lease?.release();
  lease = null;
  if (phase === "running" || phase === "starting") getBot().stop();
  phase = "passive";
  setStatus(null);
}

/**
 * The other end of the same arbitration: a dashboard saying "I am the client here".
 *
 * It **steals** the lock rather than queueing for it, because it is the deliberate one — a
 * human opened it to run a stream, and an overlay that volunteered in its absence should get
 * out of the way immediately rather than after a timeout. Within one profile that is instant
 * and unambiguous; across profiles the heartbeat does the same job a few seconds slower.
 *
 * Idempotent per page load, and that matters: the dashboard's effects re-run every time a
 * streamer walks to /avatar-config and back, and a second steal would be this page taking the
 * lock from *itself* and dutifully stopping its own bot.
 *
 * It incidentally fixes something older — two dashboard tabs in one browser were two IRC
 * connections and two EventSub sessions, i.e. everything spoken twice, with nothing to stop it.
 * Now the newer tab wins and the older one stands down.
 */
export function claimDashboardRole(): void {
  if (dashboardLease) return;
  dashboardLease = claimRunnerLease(
    {
      onAcquired: () => {},
      onStolen: () => getBot().stop(),
    },
    { steal: true },
  );
}

/* ── inbound ─────────────────────────────────────────────────────────────────────────── */

function onMessage(message: AvatarMessage) {
  if (message.type === "bot-alive") {
    // Our own echo comes back over the same channel; only somebody else's counts.
    if (message.id === CLIENT_ID) return;
    lastForeignBeat = Date.now();
    decide();
    return;
  }
  if (message.type === "setup") applySetup(message.settings);
}

/**
 * Adopt a pushed configuration.
 *
 * Written into this page's own settings store rather than kept beside it, so everything
 * downstream — the bot, per-chatter voices, the queue's pacing — reads it the ordinary way,
 * and so it *persists*: inside OBS this lands in CEF's localStorage, which is what lets a
 * restarted OBS start reading chat before any dashboard has reconnected. The bridge is
 * one-way, so an overlay that cannot remember its setup cannot ask for it again.
 *
 * Ignored outside OBS. There the overlay shares a profile with the dashboard and already has
 * the real settings; writing a copy of them back would be, at best, a no-op.
 */
function applySetup(incoming: Settings) {
  if (!isInsideObs()) return;

  const before = settingsStore.get();
  settingsStore.set(incoming);
  const after = settingsStore.get();

  if (phase !== "running") {
    decide();
    return;
  }

  const bot = getBot();
  // The store write alone reaches neither the live gain nor the open sockets — the dashboard
  // has the same split (it calls setVolume alongside its own writes).
  bot.setVolume(after.audio.masterVolume);
  void bot.setOutputDevice(after.audio.outputDeviceId);
  if (
    before.auth.channel !== after.auth.channel ||
    before.auth.token !== after.auth.token
  ) {
    void bot.reconnect();
  }
}

/* ── the decision ────────────────────────────────────────────────────────────────────── */

function dashboardAlive(): boolean {
  // Two questions with two answers, which is why there are two constants. Having heard a beat,
  // we are waiting to be sure it stopped. Having heard nothing at all, we are only waiting long
  // enough for a dashboard that already exists to get a word in.
  if (lastForeignBeat > 0) return Date.now() - lastForeignBeat < YIELD_TIMEOUT_MS;
  return Date.now() - startedAt < STARTUP_GRACE_MS;
}

function decide() {
  if (ticker === null) return;

  const configured = settingsStore.get().auth.channel.trim().length > 0;
  const held = lease?.held ?? false;
  const shouldRun = held && configured && !dashboardAlive();

  if (shouldRun && (phase === "passive" || phase === "waiting")) {
    void takeOver();
  } else if (!shouldRun && (phase === "running" || phase === "starting")) {
    void standDown(false);
  }
  evaluateStatus();
}

async function takeOver() {
  const generation = ++runGeneration;
  phase = "starting";
  okAnnounced = false;
  yieldingSince = 0;
  deafSince = 0;
  evaluateStatus();
  const bot = getBot();
  try {
    // A browser source gets no user gesture, ever. obs-browser runs CEF with the autoplay
    // policy relaxed so this simply succeeds there; the watchdog in `evaluateStatus` is for
    // when it does not, because a suspended context does not fail — `PcmPlayer.drain` keeps
    // retrying the resume forever and the queue wedges on the first message in silence.
    await bot.player.unlock();
    await bot.start();
    if (generation !== runGeneration) return; // overtaken while starting
    phase = "running";
  } catch (err) {
    if (generation !== runGeneration) return;
    phase = "running"; // started far enough that stopping is the caller's job, not ours
    setStatus({ tone: "error", text: `Moneybot TTS: ${describeError(err)}`, transient: false });
    return;
  }
  evaluateStatus();
}

/**
 * Hand the role back.
 *
 * `immediate` cuts the current line off; otherwise it is allowed to finish. A dashboard needs
 * several seconds to load voices and open its sockets after it starts announcing itself, so
 * finishing the line in flight normally costs no overlap at all — and cutting a cheer off
 * mid-word is the kind of thing a viewer notices.
 */
async function standDown(immediate: boolean) {
  if (phase !== "running" && phase !== "starting") return;

  const bot = getBot();
  if (!immediate && bot.player.isSpeaking) {
    if (yieldingSince === 0) yieldingSince = Date.now();
    if (Date.now() - yieldingSince < YIELD_LINE_CAP_MS) return; // try again next tick
  }

  runGeneration++;
  okAnnounced = false;
  yieldingSince = 0;
  deafSince = 0;
  errorShownAt = 0;
  bot.stop();
  phase = lease?.held ? "waiting" : "passive";
  setStatus(null);
}

/* ── what the overlay paints ─────────────────────────────────────────────────────────── */

/**
 * Only ever unhealthy states, plus one line on success that fades away.
 *
 * This is a deliberate exception to the overlay's rule that it draws nothing it was not given
 * — the point is that a TTS graphic which is quietly broken looks identical to a chat nobody
 * is cheering in. If it is not working, it says so, on stream, until it is fixed.
 */
function report(next: RunnerStatus | null) {
  if (next && next.tone !== "ok") okAnnounced = false;
  setStatus(next);
}

function evaluateStatus() {
  if (ticker === null) return;

  // A dashboard has the role: it shows its own errors, in far more detail, to the one person
  // who can act on them. Nothing to say here.
  if (phase === "passive") {
    report(null);
    return;
  }

  if (phase === "waiting") {
    const configured = settingsStore.get().auth.channel.trim().length > 0;
    report(
      configured
        ? null
        : {
            tone: "error",
            text: "Moneybot TTS: waiting for setup. Open the dashboard once with OBS running.",
            transient: false,
          },
    );
    return;
  }

  if (phase === "starting") {
    report({ tone: "info", text: "Moneybot TTS: connecting…", transient: false });
    return;
  }

  const bot = getBot();
  const state = bot.getSnapshot();

  if (state.voicesError) {
    report({ tone: "error", text: `Moneybot TTS: ${state.voicesError.detail}`, transient: false });
    return;
  }
  if (state.lastError) {
    if (errorShownAt === 0) errorShownAt = Date.now();
    if (Date.now() - errorShownAt < ERROR_LINGER_MS) {
      report({ tone: "error", text: `Moneybot TTS: ${state.lastError.detail}`, transient: false });
      return;
    }
    // Nobody here can click it away, so clear it and let a real fault raise it again.
    errorShownAt = 0;
    bot.dismissError();
  } else {
    errorShownAt = 0;
  }

  // Audible-output watchdog. `isSpeaking` is false while the context is suspended, so a
  // message that is playing with nothing coming out looks like a message that has not started.
  if (state.nowPlaying && !bot.player.isContextRunning) {
    if (deafSince === 0) deafSince = Date.now();
    if (Date.now() - deafSince > AUDIO_WATCHDOG_MS) {
      report({
        tone: "error",
        text: "Moneybot TTS: no audio. Right-click this source in OBS, choose Interact, and click once.",
        transient: false,
      });
      return;
    }
  } else {
    deafSince = 0;
  }

  if (state.status === "connecting") {
    report({ tone: "info", text: "Moneybot TTS: connecting…", transient: false });
    return;
  }
  if (state.status === "reconnecting") {
    report({ tone: "info", text: "Moneybot TTS: reconnecting…", transient: false });
    return;
  }
  if (state.status === "offline") {
    report({ tone: "error", text: "Moneybot TTS: chat offline.", transient: false });
    return;
  }

  // Said once per healthy run, then silence: an overlay that is working should draw nothing.
  //
  // Note what is deliberately *not* here: clearing the line. Taking it down is the linger
  // timer's job, and doing it in this branch instead means the message is wiped on the next
  // tick — half a second after it appeared, long before the CSS that fades it has begun. That
  // is a flash, not a message, and it gets shorter every time the tick is made more responsive.
  if (okAnnounced) return;
  okAnnounced = true;
  report({ tone: "ok", text: "Moneybot TTS: reading chat", transient: true });
}

function describeError(err: unknown): string {
  const e = err as { detail?: string; message?: string };
  return e?.detail || e?.message || "could not start";
}
