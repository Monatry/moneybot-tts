"use client";

/**
 * Web Audio replacement for the desktop app's NAudio `AudioPlaybackService`.
 *
 * The upstream contract is the same: 24 kHz mono audio arriving in chunks, played as it
 * arrives — as raw 16-bit signed little-endian bytes from the server engine, or as float
 * samples straight from the model on the browser engine (see `push`). NAudio had a
 * `BufferedWaveProvider` doing the buffering; here each chunk becomes an AudioBuffer
 * scheduled on the context clock, back to back, so the browser's own resampler handles the
 * 24 kHz → device-rate conversion.
 *
 * Everything is scheduled a short lead ahead of `currentTime`. That lead is the whole
 * reason playback survives a network hiccup: the audio already handed to the device keeps
 * playing while the next chunk is still in flight.
 */

/** How far ahead of the clock the first chunk of an utterance is scheduled. */
const LEAD_SECONDS = 0.15;

/** Chunks smaller than this are accumulated rather than scheduled — one node per 4 KB of
 *  network chunk would be thousands of nodes for a long message. */
const MIN_FLUSH_SAMPLES = 4800; // 0.2 s at 24 kHz

const SAMPLE_RATE = 24000;

export class PcmPlayer {
  private ctx: AudioContext | null = null;
  private gain: GainNode | null = null;
  private readonly live = new Set<AudioBufferSourceNode>();

  /** Context time the next scheduled chunk starts at. */
  private nextStartTime = 0;
  /**
   * Context time the current utterance's first chunk starts at, or -1 before anything has
   * been scheduled. Stamped by the first `flush`, deliberately not by `begin`: synthesis
   * takes a second or more to return its first bytes, and anchoring the clock at the
   * request would count that wait as audio already played — the progress bar would jump to
   * halfway the moment the first sample arrived.
   */
  private startedAt = -1;
  private playing = false;
  private paused = false;

  /** Samples accumulated but not yet long enough to be worth their own node. */
  private pendingSamples: Float32Array[] = [];
  private pendingLength = 0;
  /** A trailing byte from a chunk that split an Int16 sample down the middle. */
  private oddByte: number | null = null;

  private volume = 1;
  private sinkId = "default";

  /**
   * Creates the context on demand. Must be called from a user gesture the first time, or
   * the browser starts it suspended and nothing is audible — every entry point that can
   * lead to speech (Test audio, Test speak, arriving on the dashboard after a click)
   * routes through `unlock()`.
   */
  private ensureContext(): AudioContext {
    if (!this.ctx) {
      const Ctor: typeof AudioContext =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new Ctor();
      this.gain = this.ctx.createGain();
      this.gain.gain.value = this.volume;
      this.gain.connect(this.ctx.destination);
      void this.applySink();
    }
    return this.ctx;
  }

  /** Resumes a context the autoplay policy left suspended. Safe to call on every click. */
  async unlock(): Promise<void> {
    const ctx = this.ensureContext();
    if (ctx.state === "suspended" && !this.paused) {
      try {
        await ctx.resume();
      } catch {
        /* the next gesture gets another go */
      }
    }
  }

  get isContextRunning(): boolean {
    return this.ctx?.state === "running";
  }

  setVolume(v: number) {
    this.volume = Math.min(1, Math.max(0, v));
    if (this.gain && this.ctx) {
      // Ramped rather than assigned: a step change on a live signal clicks.
      this.gain.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.02);
    }
  }

  /**
   * Routes output to a specific device. `AudioContext.setSinkId` is Chromium-only (110+);
   * Firefox and Safari have no equivalent, so there the selection is remembered but the OS
   * default is what actually plays. Callers should surface that — see the setup screen's
   * device row.
   */
  async setSink(deviceId: string): Promise<boolean> {
    this.sinkId = deviceId || "default";
    return this.applySink();
  }

  static get supportsSinkSelection(): boolean {
    return typeof window !== "undefined" && "setSinkId" in AudioContext.prototype;
  }

  private async applySink(): Promise<boolean> {
    const ctx = this.ctx as (AudioContext & { setSinkId?: (id: string) => Promise<void> }) | null;
    if (!ctx?.setSinkId) return false;
    try {
      // "default" is the documented way to hand it back to the OS default; a device id
      // that has since been unplugged rejects, and the context keeps its previous sink.
      await ctx.setSinkId(this.sinkId === "default" ? "" : this.sinkId);
      return true;
    } catch {
      return false;
    }
  }

  /** Starts a new utterance. Anything still scheduled from the previous one is dropped. */
  begin() {
    this.ensureContext();
    this.stopAllSources();
    this.pendingSamples = [];
    this.pendingLength = 0;
    this.oddByte = null;
    this.startedAt = -1;
    this.nextStartTime = 0;
    this.playing = true;
  }

  /**
   * Appends one chunk from whichever engine is synthesising.
   *
   * Both shapes end up in the same place, and the difference is entirely upstream: the
   * server engine relays raw 16-bit PCM off a socket, arriving in network-sized pieces that
   * split samples down the middle, while the browser engine hands back a whole sentence of
   * float samples that already are what an AudioBuffer holds. Converting one into the other
   * before this point would mean either quantising the local model's output for no reason
   * or paying for a copy the network path does not need.
   */
  push(chunk: Uint8Array | Float32Array) {
    if (!this.playing || chunk.length === 0) return;

    const samples = chunk instanceof Float32Array ? chunk : this.decodeInt16(chunk);
    if (samples.length === 0) return;
    this.pendingSamples.push(samples);
    this.pendingLength += samples.length;
    if (this.pendingLength >= MIN_FLUSH_SAMPLES) this.flush();
  }

  /** Raw 16-bit LE bytes to samples, carrying a split sample across the chunk boundary. */
  private decodeInt16(bytes: Uint8Array): Float32Array {
    // Re-join a sample that a chunk boundary split in half. Without this, one byte of
    // every straddling chunk is lost and everything after it is shifted by a byte — which
    // sounds like white noise, not like a glitch.
    let offset = 0;
    let samples: Float32Array;
    if (this.oddByte !== null) {
      const total = 1 + bytes.length;
      const count = total >> 1;
      samples = new Float32Array(count);
      let s = 0;
      if (count > 0) {
        samples[s++] = int16ToFloat(this.oddByte | (bytes[0] << 8));
        offset = 1;
      }
      for (; s < count; s++, offset += 2) {
        samples[s] = int16ToFloat(bytes[offset] | (bytes[offset + 1] << 8));
      }
      this.oddByte = (total & 1) === 1 ? bytes[bytes.length - 1] : null;
    } else {
      const count = bytes.length >> 1;
      samples = new Float32Array(count);
      for (let s = 0; s < count; s++, offset += 2) {
        samples[s] = int16ToFloat(bytes[offset] | (bytes[offset + 1] << 8));
      }
      this.oddByte = (bytes.length & 1) === 1 ? bytes[bytes.length - 1] : null;
    }

    return samples;
  }

  /** Schedules whatever has accumulated, however short. Called when the stream ends. */
  flush() {
    const ctx = this.ctx;
    if (!ctx || !this.gain || this.pendingLength === 0) return;

    const merged = new Float32Array(this.pendingLength);
    let at = 0;
    for (const part of this.pendingSamples) {
      merged.set(part, at);
      at += part.length;
    }
    this.pendingSamples = [];
    this.pendingLength = 0;

    const buffer = ctx.createBuffer(1, merged.length, SAMPLE_RATE);
    buffer.copyToChannel(merged, 0);

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.gain);

    // The first chunk gets the full lead; later ones continue straight from where the
    // previous one ends. Either way never behind the clock: if the network stalled long
    // enough for the scheduled audio to run out, resuming at `nextStartTime` would schedule
    // into the past and the browser would play the whole chunk at once.
    const first = this.startedAt < 0;
    const startAt = first
      ? ctx.currentTime + LEAD_SECONDS
      : Math.max(this.nextStartTime, ctx.currentTime + 0.02);
    if (first) this.startedAt = startAt;

    source.start(startAt);
    this.nextStartTime = startAt + buffer.duration;

    this.live.add(source);
    source.onended = () => {
      this.live.delete(source);
    };
  }

  /**
   * Resolves when every scheduled sample has played out. Equivalent to the desktop
   * `DrainAndStopAsync`: it polls rather than relying on `onended`, because a paused
   * context has to hold the drain open without spinning.
   */
  async drain(signal?: AbortSignal): Promise<void> {
    this.flush();
    const ctx = this.ctx;
    if (!ctx) return;
    while (!signal?.aborted) {
      // Nothing was ever scheduled — the response carried no samples. Nothing to wait for.
      if (this.startedAt < 0) break;
      if (!this.paused && ctx.currentTime >= this.nextStartTime) break;
      // A context the autoplay policy suspended freezes its clock, so this would otherwise
      // wait forever. Keep asking: the audio is still scheduled and correct relative to the
      // frozen clock, so it picks up intact the moment a gesture frees the context.
      if (!this.paused && ctx.state === "suspended") void ctx.resume();
      await sleep(40);
    }
    this.playing = false;
  }

  /** Cuts playback dead. What Skip, Clear and Stop all call. */
  stopImmediate() {
    this.stopAllSources();
    this.pendingSamples = [];
    this.pendingLength = 0;
    this.oddByte = null;
    this.playing = false;
    this.startedAt = -1;
    this.nextStartTime = 0;
  }

  private stopAllSources() {
    for (const src of this.live) {
      try {
        src.onended = null;
        src.stop();
      } catch {
        /* already ended */
      }
    }
    this.live.clear();
  }

  async setPaused(paused: boolean): Promise<void> {
    const ctx = this.ensureContext();
    this.paused = paused;
    try {
      // Suspending freezes `currentTime` as well as the output, so every already-scheduled
      // start time stays correct relative to the clock and playback picks up mid-word.
      if (paused) await ctx.suspend();
      else await ctx.resume();
    } catch {
      /* the state we asked for was already the state it was in */
    }
  }

  get isPaused(): boolean {
    return this.paused;
  }

  /**
   * True only while samples are actually reaching the device — not merely while a message
   * is in progress. Playback starts empty and stays empty for as long as the server takes
   * to return the first chunk, and this is what the avatar's mouth gates on: animating
   * straight off "synthesis requested" flaps it over several hundred ms of silence.
   */
  get isSpeaking(): boolean {
    const ctx = this.ctx;
    if (!ctx || this.paused || this.startedAt < 0 || ctx.state !== "running") return false;
    return ctx.currentTime >= this.startedAt && ctx.currentTime < this.nextStartTime;
  }

  /** Seconds of the current utterance already played. */
  get playedSeconds(): number {
    const ctx = this.ctx;
    if (!ctx || this.startedAt < 0) return 0;
    return Math.max(0, Math.min(ctx.currentTime - this.startedAt, this.scheduledSeconds));
  }

  /** Seconds of the current utterance scheduled so far — the exact length once the stream ends. */
  get scheduledSeconds(): number {
    if (this.startedAt < 0) return 0;
    return Math.max(0, this.nextStartTime - this.startedAt);
  }

  dispose() {
    this.stopImmediate();
    void this.ctx?.close();
    this.ctx = null;
    this.gain = null;
  }
}

function int16ToFloat(u16: number): number {
  // The bytes arrive unsigned; sign-extend before scaling.
  const signed = u16 >= 0x8000 ? u16 - 0x10000 : u16;
  return signed / 32768;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
