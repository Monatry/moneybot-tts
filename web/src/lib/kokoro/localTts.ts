"use client";

/**
 * The page's half of the browser engine: owns the worker, and dresses it up as the same
 * two calls the server engine offers (`loadVoices`, `openPcmStream`), so `ttsQueue` cannot
 * tell which one it is running against.
 *
 * Deliberately tiny. Everything expensive — kokoro-js, transformers.js, onnxruntime-web —
 * lives behind `new Worker(new URL(...))` in `./worker`, which the bundler splits into its
 * own chunk; nothing in this file pulls any of it into the page bundle.
 */

import type { FromWorker, LoadProgress, ResolvedBackend, ToWorker } from "./protocol";
import { settingsStore } from "../settings";
import { KOKORO_MODEL_ID } from "../ttsEngine";

/**
 * Failure to get Kokoro running in this browser. Distinct from the server engine's
 * `AccessDeniedError`, whose "you are not whitelisted" wording means nothing here: there is
 * no whitelist and no server, so a failure is WebGPU, WebAssembly, storage or the model
 * download, and the `detail` is the only thing that says which.
 */
export class LocalTtsError extends Error {
  readonly detail: string;
  constructor(detail: string) {
    super("Kokoro could not start in this browser.");
    this.name = "LocalTtsError";
    this.detail = detail;
  }
}

export interface LocalTtsStatus {
  phase: "idle" | "loading" | "ready" | "error";
  /** 0–100 while loading; 100 once ready. */
  percent: number;
  detail: string;
  /** What the worker settled on. Null until ready. */
  backend: ResolvedBackend | null;
}

let status: LocalTtsStatus = { phase: "idle", percent: 0, detail: "", backend: null };
const statusListeners = new Set<(s: LocalTtsStatus) => void>();

export function getStatus(): LocalTtsStatus {
  return status;
}

export function subscribeStatus(listener: (s: LocalTtsStatus) => void): () => void {
  statusListeners.add(listener);
  return () => statusListeners.delete(listener);
}

function setStatus(part: Partial<LocalTtsStatus>) {
  status = { ...status, ...part };
  for (const l of statusListeners) l(status);
}

/* ── the worker ──────────────────────────────────────────────────────────────────────── */

let worker: Worker | null = null;
let ready: Promise<string[]> | null = null;
let resolveReady: ((voices: string[]) => void) | null = null;
let rejectReady: ((err: Error) => void) | null = null;

/**
 * How long an utterance may produce *nothing at all* before it is declared lost.
 *
 * Only the first chunk is timed, and the bound is deliberately far beyond any real
 * synthesis: a sentence is a few seconds on a slow laptop, so two minutes of complete
 * silence is not a slow machine, it is a worker that is never going to answer. Once a
 * message is flowing the timer is gone and a long one can take as long as it likes.
 *
 * It exists because the failure it catches is otherwise unrecoverable rather than merely
 * annoying: the queue awaits this stream, so a `speak` that never answers leaves the
 * dashboard on "now speaking" with no audio, and Skip cannot rescue it — the worker's
 * cancel is only read between sentences, and a worker stuck before the first one never
 * gets there. Every later message then queues behind it for the rest of the stream. That
 * is exactly what an unclosed `TextSplitterStream` used to do (see worker.ts), and a
 * live-stream tool should degrade to one skipped message rather than to a dead queue.
 */
const FIRST_CHUNK_TIMEOUT_MS = 120_000;

interface PendingStream {
  controller: ReadableStreamDefaultController<Float32Array>;
  /** Cleared by the first chunk, or by the utterance ending. */
  watchdog: ReturnType<typeof setTimeout> | null;
}

/** In-flight utterances, by the id `openPcmStream` allocated for them. */
const streams = new Map<number, PendingStream>();
let seq = 0;

/** Forgets an utterance and stops its watchdog. Every exit path goes through here. */
function finish(id: number): PendingStream | undefined {
  const pending = streams.get(id);
  if (pending?.watchdog) clearTimeout(pending.watchdog);
  streams.delete(id);
  return pending;
}

/** Fails every in-flight utterance — for the load failing, or the worker dying under them. */
function failAll(err: Error) {
  for (const id of [...streams.keys()]) finish(id)?.controller.error(err);
}

function send(message: ToWorker, transfer?: Transferable[]) {
  worker?.postMessage(message, transfer ?? []);
}

function ensureWorker(): Worker {
  if (worker) return worker;

  // `new URL(..., import.meta.url)` is what the bundler recognises: it emits ./worker.ts as
  // a separate module chunk and rewrites this to its hashed URL, prefixed with the app's
  // asset path — which is why this needs no `withBasePath` even under /moneytts.
  worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });

  worker.onmessage = (event: MessageEvent<FromWorker>) => {
    const msg = event.data;
    switch (msg.type) {
      case "progress":
        setStatus({ phase: "loading", percent: msg.progress.percent, detail: describe(msg.progress) });
        break;

      case "ready":
        setStatus({ phase: "ready", percent: 100, detail: "", backend: msg.backend });
        resolveReady?.(msg.voices);
        resolveReady = null;
        rejectReady = null;
        break;

      case "initFailed": {
        setStatus({ phase: "error", percent: 0, detail: msg.detail });
        const err = new LocalTtsError(msg.detail);
        rejectReady?.(err);
        resolveReady = null;
        rejectReady = null;
        // Every waiting utterance dies with it, or they would hang forever on a model that
        // is never going to arrive.
        failAll(err);
        break;
      }

      case "chunk": {
        const pending = streams.get(msg.id);
        if (!pending) break;
        // Audio is flowing; the watchdog has done its job and must not fire mid-message.
        if (pending.watchdog) {
          clearTimeout(pending.watchdog);
          pending.watchdog = null;
        }
        pending.controller.enqueue(msg.samples);
        break;
      }

      case "end":
        finish(msg.id)?.controller.close();
        break;

      case "failed":
        finish(msg.id)?.controller.error(new LocalTtsError(msg.detail));
        break;
    }
  };

  // A worker that dies outright (out of memory on a 300 MB fp32 graph is the realistic
  // way) raises this and nothing else. Without it the queue waits on a promise nobody will
  // ever settle.
  worker.onerror = (event) => {
    const detail = event.message || "The synthesis worker stopped unexpectedly";
    setStatus({ phase: "error", percent: 0, detail });
    const err = new LocalTtsError(detail);
    rejectReady?.(err);
    resolveReady = null;
    rejectReady = null;
    failAll(err);
    // Dropped so the next attempt builds a fresh one — a worker that has errored out does
    // not recover, and reusing it would fail every message from here on.
    worker?.terminate();
    worker = null;
    ready = null;
  };

  return worker;
}

function describe(progress: LoadProgress): string {
  return progress.phase === "warming" ? "Warming up the model" : `Downloading ${progress.detail}`;
}

/**
 * Loads the model if it is not loaded, and answers with the voice ids it supports.
 *
 * The first call is slow — tens of megabytes of weights from the Hugging Face CDN, then a
 * warm-up inference — and every later one is instant, because the browser's Cache Storage
 * keeps the weights across reloads and across streams. Callers should show
 * `subscribeStatus` while awaiting it rather than a spinner.
 */
export function loadVoices(): Promise<string[]> {
  if (ready) return ready;

  ready = new Promise<string[]>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = (err) => {
      // Cleared so a failure is retryable: a streamer who was offline when the model was
      // first requested gets another go by revisiting the screen.
      ready = null;
      reject(err);
    };
  });

  setStatus({ phase: "loading", percent: 0, detail: "Starting Kokoro", backend: null });
  ensureWorker();

  const { device, dtype } = settingsStore.get().localTts;
  send({ type: "init", modelId: KOKORO_MODEL_ID, device, dtype });

  return ready;
}

/**
 * Drops the loaded model so the next `loadVoices` starts over on the current settings.
 * What the device/precision controls call — a running ONNX session cannot be re-targeted,
 * so changing the backend means a new worker.
 */
export function reset() {
  failAll(new LocalTtsError("The voice model was reloaded"));
  worker?.terminate();
  worker = null;
  ready = null;
  resolveReady = null;
  rejectReady = null;
  setStatus({ phase: "idle", percent: 0, detail: "", backend: null });
}

/**
 * Synthesises one utterance, as a stream of 24 kHz mono float samples — one chunk per
 * sentence, arriving as the model finishes each.
 *
 * A `ReadableStream` rather than a callback purely so `ttsQueue` reads it with the same
 * `reader.read()` loop it uses for the server engine's `fetch` body. The abort signal is
 * wired to both ends: it errors the reader (which the queue reads as a skip) and tells the
 * worker to stop at the next sentence boundary.
 */
export async function openPcmStream(
  text: string,
  voice: string,
  speed: number,
  signal?: AbortSignal,
): Promise<ReadableStreamDefaultReader<Float32Array>> {
  await loadVoices();

  const id = ++seq;
  ensureWorker();

  const stream = new ReadableStream<Float32Array>({
    start: (controller) => {
      streams.set(id, {
        controller,
        watchdog: setTimeout(() => {
          finish(id)?.controller.error(
            new LocalTtsError(
              `Synthesis produced nothing for ${FIRST_CHUNK_TIMEOUT_MS / 1000}s — the worker is not responding`,
            ),
          );
          send({ type: "cancel", id });
        }, FIRST_CHUNK_TIMEOUT_MS),
      });
    },
    cancel: () => {
      finish(id);
      send({ type: "cancel", id });
    },
  });

  const onAbort = () => {
    const pending = finish(id);
    send({ type: "cancel", id });
    // The same shape a cancelled fetch produces, so the queue's `error.name ===
    // "AbortError"` branch treats a skip here exactly as it does there.
    pending?.controller.error(new DOMException("skipped", "AbortError"));
  };

  if (signal) {
    if (signal.aborted) {
      send({ type: "cancel", id });
      throw new DOMException("skipped", "AbortError");
    }
    signal.addEventListener("abort", onAbort, { once: true });
  }

  send({ type: "speak", id, text, voice, speed });
  return stream.getReader();
}
