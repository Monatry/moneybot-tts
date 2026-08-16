"use client";

import { useSyncExternalStore } from "react";
import { PcmPlayer } from "./audioPlayer";
import { postAvatarMessage } from "./avatarStore";
import { cleanChatText, splitVoicePrefix } from "./chatText";
import { getViewerCount } from "./helix";
import { settingsStore, type Settings } from "./settings";
import { fetchVoices, estimateSeconds, AccessDeniedError } from "./ttsClient";
import { TtsQueue } from "./ttsQueue";
import { TwitchEventSubClient } from "./twitchEventSub";
import { TwitchIrcClient } from "./twitchIrc";
import type { ChatEntry, ConnectionStatus, NowPlaying, TtsRequest } from "./types";

/**
 * The running bot: chat in, speech out.
 *
 * A module-level singleton rather than React state, because it has to outlive the component
 * tree. The dashboard and the avatar-config screen are separate routes, and a streamer
 * moving between them must not tear down the IRC connection or drop the queue. React reads
 * it through `useBot()`; nothing else in the tree owns any of this.
 */

const MAX_CHAT_ENTRIES = 200;

/** Same cap the desktop dashboard had: the whole list re-renders on every change. */
export const MAX_QUEUE_ROWS = 50;

export interface BotState {
  status: ConnectionStatus;
  /** Last human-readable note from the connection — why a token was ignored, and so on. */
  statusMessage: string;
  queue: TtsRequest[];
  nowPlaying: NowPlaying | null;
  chat: ChatEntry[];
  voices: string[];
  /** Set when the voice list could not be loaded. Message + detail, per AccessDeniedError. */
  voicesError: { message: string; detail: string } | null;
  bitsReadToday: number;
  viewerCount: number | null;
  isSpeaking: boolean;
  paused: boolean;
  /** Seconds left on the pacing gap, for the queue header. */
  holdRemaining: number;
  lastError: { message: string; detail: string } | null;
}

const INITIAL: BotState = {
  status: "offline",
  statusMessage: "",
  queue: [],
  nowPlaying: null,
  chat: [],
  voices: [],
  voicesError: null,
  bitsReadToday: 0,
  viewerCount: null,
  isSpeaking: false,
  paused: false,
  holdRemaining: 0,
  lastError: null,
};

/** Fallback colours for chatters who have never set one, per the design's chat name tints. */
const NAME_COLORS = ["#5f22bd", "#0f7b6c", "#a5811b", "#b3355a", "#5f7b0f"];

function colorFor(user: string): string {
  let hash = 0;
  for (let i = 0; i < user.length; i++) hash = (hash * 31 + user.charCodeAt(i)) | 0;
  return NAME_COLORS[Math.abs(hash) % NAME_COLORS.length];
}

/**
 * Queue ids have to be unique because the per-row ✕ removes by id — a timestamp alone is
 * not, and four messages enqueued in the same millisecond would all vanish on one click.
 */
let idCounter = 0;
function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${Date.now()}-${idCounter}`;
}

const BITS_KEY = "moneybot.bitsToday.v1";

function loadBitsToday(): number {
  try {
    const raw = localStorage.getItem(BITS_KEY);
    if (!raw) return 0;
    const parsed = JSON.parse(raw) as { date: string; bits: number };
    // Keyed by local date, so the counter the nav pill shows resets overnight rather than
    // accumulating across streams.
    return parsed.date === new Date().toDateString() ? parsed.bits : 0;
  } catch {
    return 0;
  }
}

function saveBitsToday(bits: number) {
  try {
    localStorage.setItem(BITS_KEY, JSON.stringify({ date: new Date().toDateString(), bits }));
  } catch {
    /* a lost counter is not worth an error */
  }
}

class Bot {
  private state: BotState = INITIAL;
  private listeners = new Set<() => void>();

  readonly player = new PcmPlayer();
  private queue: TtsQueue;
  private irc: TwitchIrcClient;
  private eventSub: TwitchEventSubClient;

  private ticker: number | null = null;
  private viewerTimer: number | null = null;
  private voicesLoad: Promise<string[]> | null = null;
  private started = false;
  private lastBroadcastSpeaking = false;
  private lastBroadcastText: string | null = null;
  private hydrated = false;

  constructor() {
    this.queue = new TtsQueue(
      this.player,
      () => this.state.voices,
      () => {
        const s = settingsStore.get();
        return {
          minDelayMs: s.audio.minDelayMs,
          playbackRate: s.audio.playbackRate,
          allowChatterVoiceOverride: s.allowChatterVoiceOverride,
        };
      },
      {
        onQueueChanged: () => this.patch({ queue: this.queue.snapshot() }),
        onStarted: (req) => this.patch({ nowPlaying: { request: req, progress: 0 } }),
        onCompleted: (req) => this.onSpoken(req),
        onFailed: (req, err) => this.onFailed(req, err),
      },
    );

    this.irc = new TwitchIrcClient({
      onMessage: (msg) => this.onChatMessage(msg),
      onConnectionChange: (connected) =>
        this.patch({ status: connected ? "connected" : this.started ? "reconnecting" : "offline" }),
      onStatus: (message) => this.patch({ statusMessage: message }),
    });

    this.eventSub = new TwitchEventSubClient({
      onRedemption: (e) => this.onRedemption(e),
      onStatus: (message) => this.patch({ statusMessage: message }),
    });
  }

  /* ── store plumbing ─────────────────────────────────────────────────────── */

  getSnapshot = (): BotState => {
    if (!this.hydrated && typeof window !== "undefined") {
      this.hydrated = true;
      this.state = { ...this.state, bitsReadToday: loadBitsToday() };
    }
    return this.state;
  };

  getServerSnapshot = (): BotState => INITIAL;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private patch(part: Partial<BotState>) {
    this.state = { ...this.state, ...part };
    for (const l of this.listeners) l();
  }

  /* ── lifecycle ──────────────────────────────────────────────────────────── */

  /**
   * Loads the voice list and opens both Twitch connections. Idempotent: calling it again
   * with changed settings reconnects, which is what every trigger toggle on the dashboard
   * relies on.
   */
  async start(): Promise<void> {
    const settings = settingsStore.get();
    this.started = true;
    this.patch({ status: "connecting" });

    await this.ensureVoices();

    this.player.setVolume(settings.audio.masterVolume);
    void this.player.setSink(settings.audio.outputDeviceId);

    this.queue.start();
    await this.irc.connect(settings.auth.channel, settings.auth.token);
    await this.eventSub.connect(settings.auth.token);

    this.startTicker();
    this.refreshViewers();
  }

  stop() {
    this.started = false;
    this.queue.stop();
    this.irc.disconnect();
    this.eventSub.disconnect();
    if (this.ticker !== null) {
      clearInterval(this.ticker);
      this.ticker = null;
    }
    if (this.viewerTimer !== null) {
      clearInterval(this.viewerTimer);
      this.viewerTimer = null;
    }
    this.setSpeakingBroadcast(false, null);
    this.patch({ status: "offline", nowPlaying: null, isSpeaking: false });
  }

  get isStarted(): boolean {
    return this.started;
  }

  /** Loads the voice list once. Safe to call from anywhere that needs voices to exist. */
  async ensureVoices(): Promise<string[]> {
    if (this.state.voices.length > 0) return this.state.voices;
    // Deduped on the in-flight promise, not just on the result: several screens ask for the
    // list on mount, and React's development double-invoke makes each of those two calls —
    // checking `voices.length` alone lets all of them through before the first resolves.
    if (!this.voicesLoad) {
      this.voicesLoad = (async () => {
        try {
          const voices = await fetchVoices();
          this.patch({ voices, voicesError: null });
          return voices;
        } catch (err) {
          const e = err as AccessDeniedError;
          this.patch({ voicesError: { message: e.message, detail: e.detail ?? "" } });
          return [];
        } finally {
          // Cleared either way, so a failed load can be retried by the next screen rather
          // than being cached as permanently broken.
          this.voicesLoad = null;
        }
      })();
    }
    return this.voicesLoad;
  }

  /* ── settings changes ───────────────────────────────────────────────────── */

  setVolume(v: number) {
    this.player.setVolume(v);
  }

  async setOutputDevice(deviceId: string): Promise<boolean> {
    return this.player.setSink(deviceId);
  }

  /** Reconnects both Twitch clients — for a channel or token change. */
  async reconnect(): Promise<void> {
    if (!this.started) return;
    const settings = settingsStore.get();
    this.patch({ status: "connecting" });
    await this.irc.connect(settings.auth.channel, settings.auth.token);
    await this.eventSub.connect(settings.auth.token);
    this.refreshViewers();
  }

  /* ── queue controls ─────────────────────────────────────────────────────── */

  skip() {
    this.queue.skipCurrent();
  }

  clearQueue() {
    this.queue.clear();
  }

  removeFromQueue(id: string) {
    this.queue.remove(id);
  }

  async togglePause(): Promise<void> {
    const next = !this.player.isPaused;
    await this.player.setPaused(next);
    this.patch({ paused: next });
  }

  /**
   * Speaks one line immediately, outside the queue — the setup screen's "Test audio" and
   * the avatar screen's "Test speak". An empty `user` means it never burns a voice entry on
   * a name nobody chats under, so every press rolls a fresh voice.
   */
  enqueueTest(text: string) {
    const settings = settingsStore.get();
    this.queue.enqueue({
      id: nextId("test"),
      text,
      user: "",
      source: "chat",
      estSeconds: estimateSeconds(text, settings.audio.playbackRate),
      receivedAt: Date.now(),
    });
    if (!this.queue.nowPlaying) this.queue.start();
    this.startTicker();
  }

  /* ── inbound events ─────────────────────────────────────────────────────── */

  private onChatMessage(msg: {
    user: string;
    displayName: string;
    color: string;
    text: string;
    bits: number;
    id: string;
  }) {
    const settings = settingsStore.get();

    // Cleaned here, before anything else looks at the message: the voice would otherwise
    // narrate emoji, and an invisible leading character stops the [voice] prefix below from
    // matching. See lib/chatText.ts.
    const body = cleanChatText(msg.text);

    // The chat column mirrors Twitch, so it shows everything regardless of what the
    // triggers let through to the queue.
    this.pushChat({
      id: msg.id,
      user: msg.displayName,
      color: msg.color || colorFor(msg.user),
      text: msg.text,
      kind: msg.bits > 0 ? "cheer" : "chat",
      bits: msg.bits || undefined,
      at: Date.now(),
    });

    if (msg.bits > 0) {
      if (settings.triggers.cheers.enabled && msg.bits >= settings.triggers.cheers.minBits) {
        const text = `${msg.displayName} cheered ${msg.bits} bits: ${body}`.trimEnd();
        this.enqueue({
          id: msg.id,
          text,
          user: msg.user,
          source: "cheer",
          bits: msg.bits,
          estSeconds: estimateSeconds(text, settings.audio.playbackRate),
          receivedAt: Date.now(),
        });
      }
      return;
    }

    if (!settings.triggers.chat) return;
    // Nothing speakable survived — an emoji-only message.
    if (body.length === 0) return;

    let text = body;
    let voiceOverride: string | undefined;
    if (settings.allowChatterVoiceOverride) {
      const split = splitVoicePrefix(text);
      if (split) {
        voiceOverride = split.voice;
        text = split.text;
      }
    }

    this.enqueue({
      id: msg.id,
      text,
      user: msg.user,
      source: "chat",
      voiceOverride,
      estSeconds: estimateSeconds(text, settings.audio.playbackRate),
      receivedAt: Date.now(),
    });
  }

  private onRedemption(e: {
    user: string;
    displayName: string;
    rewardTitle: string;
    userInput: string;
  }) {
    const settings = settingsStore.get();
    // Same treatment as chat: the redeem box accepts emoji too.
    const input = cleanChatText(e.userInput);

    this.pushChat({
      id: nextId("redeem-chat"),
      user: e.displayName,
      color: colorFor(e.user),
      text: e.userInput,
      kind: "redeem",
      rewardName: e.rewardTitle,
      at: Date.now(),
    });

    if (!settings.triggers.redeems.enabled) return;
    const wanted = settings.triggers.redeems.rewardName.trim();
    // An unset reward name matches nothing rather than everything: one redeem drives the
    // queue, and the alternative would read every redeem on the channel out loud.
    if (!wanted || wanted.toLowerCase() !== e.rewardTitle.toLowerCase()) return;

    const text = input.length === 0 ? e.displayName : input;
    this.enqueue({
      id: nextId("redeem"),
      text,
      user: e.user,
      source: "redeem",
      estSeconds: estimateSeconds(text, settings.audio.playbackRate),
      receivedAt: Date.now(),
    });
  }

  private enqueue(req: TtsRequest) {
    this.queue.enqueue(req);
    this.startTicker();
  }

  private pushChat(entry: ChatEntry) {
    const chat = [...this.state.chat, entry];
    if (chat.length > MAX_CHAT_ENTRIES) chat.splice(0, chat.length - MAX_CHAT_ENTRIES);
    this.patch({ chat });
  }

  private onSpoken(req: TtsRequest) {
    if (req.source === "cheer" && req.bits) {
      const bits = this.state.bitsReadToday + req.bits;
      saveBitsToday(bits);
      this.patch({ bitsReadToday: bits });
    }
    this.patch({ nowPlaying: null, queue: this.queue.snapshot() });
  }

  private onFailed(req: TtsRequest, err: Error) {
    const detail = err instanceof AccessDeniedError ? err.detail : err.message;
    this.patch({
      nowPlaying: null,
      queue: this.queue.snapshot(),
      lastError: { message: err.message, detail },
    });
  }

  dismissError() {
    this.patch({ lastError: null });
  }

  /* ── polling ────────────────────────────────────────────────────────────── */

  /**
   * Drives the progress bar, the pacing countdown and the avatar's mouth.
   *
   * The mouth gates on `player.isSpeaking` rather than on the start event, because
   * synthesis is *requested* several hundred ms before the first sample reaches the device
   * and animating straight off the event flaps it over silence. That gate also self-corrects
   * the one path that raises no completion event: stopping mid-message.
   */
  private startTicker() {
    if (this.ticker !== null) return;
    this.ticker = window.setInterval(() => {
      const speaking = this.player.isSpeaking;
      const nowPlaying = this.queue.nowPlaying;
      const hold = this.queue.holdRemaining;

      let progress = 0;
      if (nowPlaying) {
        // The denominator is the estimate until the stream finishes arriving, then the
        // exact scheduled length — so the bar never sits pinned at 100% waiting for audio
        // that is still being synthesised.
        const total = Math.max(this.player.scheduledSeconds, nowPlaying.estSeconds);
        progress = total > 0 ? Math.min(1, this.player.playedSeconds / total) : 0;
      }

      this.patch({
        isSpeaking: speaking,
        holdRemaining: hold,
        nowPlaying: nowPlaying ? { request: nowPlaying, progress } : null,
      });
      this.setSpeakingBroadcast(speaking, nowPlaying?.text ?? null);

      // Nothing playing, nothing queued, no gap running — stop burning a timer.
      if (!nowPlaying && this.queue.depth === 0 && hold === 0 && !speaking) {
        if (this.ticker !== null) {
          clearInterval(this.ticker);
          this.ticker = null;
        }
      }
    }, 100);
  }

  /**
   * Tells the overlay whether to animate, and what line to caption.
   *
   * The text rides along with the speaking flag rather than travelling on its own, so the
   * caption appears and disappears with the audio exactly as the mouth does. Both are
   * compared before sending: two messages back to back can keep `speaking` true across the
   * boundary, and the caption would then be a line behind.
   */
  private setSpeakingBroadcast(speaking: boolean, text: string | null) {
    const line = speaking ? text : null;
    if (speaking === this.lastBroadcastSpeaking && line === this.lastBroadcastText) return;
    this.lastBroadcastSpeaking = speaking;
    this.lastBroadcastText = line;
    postAvatarMessage({ type: "speaking", speaking, text: line });
  }

  private refreshViewers() {
    const poll = async () => {
      const s = settingsStore.get();
      if (!s.auth.token || !s.auth.channel) return;
      const count = await getViewerCount(s.auth.channel, s.auth.token);
      this.patch({ viewerCount: count });
    };
    void poll();
    if (this.viewerTimer === null) {
      this.viewerTimer = window.setInterval(poll, 60_000);
    }
  }
}

let instance: Bot | null = null;

export function getBot(): Bot {
  if (!instance) {
    instance = new Bot();
    // Development-only handle. The runtime has no UI of its own and most of what goes wrong
    // in it (a stalled queue, a context that never resumed) is invisible from the DOM.
    if (process.env.NODE_ENV !== "production" && typeof window !== "undefined") {
      (window as unknown as { __moneybot: Bot }).__moneybot = instance;
    }
  }
  return instance;
}

export function useBot(): BotState {
  const bot = getBot();
  return useSyncExternalStore(bot.subscribe, bot.getSnapshot, bot.getServerSnapshot);
}

export type { Bot };
export type { Settings };
