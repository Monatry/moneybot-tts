"use client";

import type { PcmPlayer } from "./audioPlayer";
import { AccessDeniedError, openPcmStream } from "./ttsClient";
import { resolveVoiceFor, setUserVoice } from "./userVoices";
import type { TtsRequest } from "./types";

/**
 * The speech queue. Port of the desktop `TtsQueueService`, and the ordering rules it
 * encodes are the reason this is a class rather than a bare array:
 *
 *   enqueue → wait for something to read → hold for the pacing gap → dequeue →
 *   resolve voice → stream PCM → feed the player → drain → completed
 *
 * `minDelayMs` is the minimum gap between the *end* of one message and the start of the
 * next; anything arriving inside the gap waits its turn. It is read live on every item, so
 * changing it takes effect without a restart. `lastFinishedAt` is set in a `finally`, so the
 * gap applies equally to messages that played out, were skipped, or failed — and it starts
 * null, so the first message after a quiet stretch is never delayed.
 *
 * The hold happens *before* the dequeue, not after. Dequeuing first and then sleeping would
 * pull the item out while nothing is playing, and it would disappear from the queue view for
 * the length of the gap. Skip cancels the hold as well as the stream: pressing skip during a
 * gap means "read the next one now", not "throw it away".
 */

export interface QueueConfig {
  minDelayMs: number;
  playbackRate: number;
  allowChatterVoiceOverride: boolean;
}

export interface QueueHandlers {
  onQueueChanged: () => void;
  onStarted: (req: TtsRequest) => void;
  onCompleted: (req: TtsRequest) => void;
  onFailed: (req: TtsRequest, error: Error) => void;
}

export class TtsQueue {
  private pending: TtsRequest[] = [];
  private current: TtsRequest | null = null;

  private running = false;
  private stopped = true;

  /** Resolves when something is enqueued, so the loop can await an empty queue cheaply. */
  private wake: (() => void) | null = null;
  /** Resolves when the pacing hold is cut short by skip, clear or stop. */
  private cancelHold: (() => void) | null = null;
  /** Aborts the item currently being synthesised. */
  private skip: AbortController | null = null;

  /** Timestamp the last playback finished; null until something has played. */
  private lastFinishedAt: number | null = null;
  /** Timestamp the held item is released at; null when not holding. */
  private releaseAt: number | null = null;

  constructor(
    private readonly player: PcmPlayer,
    private readonly getVoices: () => readonly string[],
    private readonly getConfig: () => QueueConfig,
    private readonly handlers: QueueHandlers,
  ) {}

  /** Everything still waiting, oldest first. A copy — safe to render from. */
  snapshot(): TtsRequest[] {
    return [...this.pending];
  }

  get depth(): number {
    return this.pending.length;
  }

  get nowPlaying(): TtsRequest | null {
    return this.current;
  }

  /** Seconds left on the pacing gap before the head of the queue is read. 0 when not holding. */
  get holdRemaining(): number {
    if (this.releaseAt === null) return 0;
    return Math.max(0, (this.releaseAt - Date.now()) / 1000);
  }

  enqueue(req: TtsRequest) {
    this.pending.push(req);
    this.handlers.onQueueChanged();
    this.wake?.();
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.stopped = false;
    void this.run();
  }

  stop() {
    this.running = false;
    this.stopped = true;
    this.cancelHold?.();
    this.skip?.abort();
    this.wake?.();
    this.player.stopImmediate();
    this.releaseAt = null;
    this.current = null;
    this.handlers.onQueueChanged();
  }

  /** Ends the current message and moves on. Cuts a running pacing gap short too. */
  skipCurrent() {
    this.skip?.abort();
    this.cancelHold?.();
  }

  /** Drops everything still waiting. The message currently playing is left alone. */
  clear() {
    this.pending = [];
    // The loop may be holding an item that is no longer queued; waking it lets it discover
    // the queue is empty instead of sitting out the whole gap first.
    this.cancelHold?.();
    this.handlers.onQueueChanged();
  }

  /** Removes one waiting item — the per-row ✕. */
  remove(id: string) {
    const before = this.pending.length;
    this.pending = this.pending.filter((r) => r.id !== id);
    if (this.pending.length !== before) this.handlers.onQueueChanged();
  }

  private async run() {
    while (this.running) {
      if (this.pending.length === 0) {
        await new Promise<void>((resolve) => {
          this.wake = resolve;
        });
        this.wake = null;
        if (!this.running) break;
        continue;
      }

      await this.holdForPacing();
      if (!this.running) break;

      const req = this.pending.shift();
      if (!req) continue; // cleared out from under us during the hold
      this.handlers.onQueueChanged();

      await this.play(req);
    }
  }

  /**
   * Blocks until `minDelayMs` has passed since the last message finished. Returns
   * immediately when the gap is 0, when nothing has played yet, or when skip/clear/stop
   * cuts the wait short.
   */
  private async holdForPacing(): Promise<void> {
    this.releaseAt = null;

    const gap = Math.max(0, this.getConfig().minDelayMs);
    const since = this.lastFinishedAt;
    if (gap === 0 || since === null) return;

    const releaseAt = since + gap;
    const remaining = releaseAt - Date.now();
    if (remaining <= 0) return;

    this.releaseAt = releaseAt;
    this.handlers.onQueueChanged();

    await new Promise<void>((resolve) => {
      const timer = window.setTimeout(finish, remaining);
      this.cancelHold = finish;
      function finish() {
        clearTimeout(timer);
        resolve();
      }
    });

    this.cancelHold = null;
    this.releaseAt = null;
    this.handlers.onQueueChanged();
  }

  private async play(req: TtsRequest) {
    const controller = new AbortController();
    this.skip = controller;

    const config = this.getConfig();
    req.voice = this.resolveVoice(req, config);
    this.current = req;
    this.handlers.onStarted(req);

    try {
      this.player.begin();
      const reader = await openPcmStream(req.text, req.voice, config.playbackRate, controller.signal);
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) this.player.push(value);
      }
      this.player.flush();
      await this.player.drain(controller.signal);
      if (controller.signal.aborted) throw new DOMException("skipped", "AbortError");
      this.handlers.onCompleted(req);
    } catch (err) {
      const error = err as Error;
      this.player.stopImmediate();
      if (error.name === "AbortError") {
        // A skipped message is still finished as far as the UI is concerned. Without this
        // the "now speaking" card would sit on it for the whole pacing gap. A *stopped*
        // one is different — the runtime is shutting down and there is nothing to advance.
        if (!this.stopped) this.handlers.onCompleted(req);
      } else if (error instanceof AccessDeniedError) {
        this.handlers.onFailed(req, error);
      } else {
        this.handlers.onFailed(req, error);
      }
    } finally {
      // The gap is measured from here, so it applies equally to messages that played out,
      // were skipped, or failed.
      this.lastFinishedAt = Date.now();
      this.skip = null;
      this.current = null;
    }
  }

  /**
   * The voice this message is read in. Every chatter keeps one voice for good: a `[voice]`
   * prefix repins them to whatever they asked for (any language), and anyone without an
   * entry yet is rolled a random English one and remembered.
   */
  private resolveVoice(req: TtsRequest, config: QueueConfig): string {
    const voices = this.getVoices();

    if (req.voiceOverride && config.allowChatterVoiceOverride) {
      // Deliberately not filtered to English — the whole point of asking by name is to
      // reach a voice the random roll would never hand out.
      const picked = voices.find((v) => v.toLowerCase() === req.voiceOverride!.toLowerCase());
      if (picked) {
        setUserVoice(req.user, picked);
        return picked;
      }
      // Unknown voice id — fall through and read them in the one they already have.
    }

    // Null only when the voice list never loaded; the server's own default is the best
    // guess left at that point.
    return resolveVoiceFor(req.user, voices) ?? "af_sky";
  }
}
