/**
 * Kokoro, running in the streamer's own browser.
 *
 * This is the whole of the browser engine's synthesis. It replaces `server/kokoro.ts` plus
 * the FastAPI service behind it: same model (Kokoro 82M v1.0), same 24 kHz mono output,
 * same sentence-at-a-time streaming — just no network hop and no upstream host.
 *
 * **It must be a worker.** Inference is a few hundred milliseconds to a few seconds of
 * solid CPU per sentence, and the page it would otherwise block is the one scheduling audio
 * on the Web Audio clock and animating the avatar's mouth at 100 ms. On the main thread a
 * long message stutters its own playback.
 *
 * Nothing here imports from the rest of the app except `./protocol` (types only). The
 * bundler gives this file its own chunk, so kokoro-js, transformers.js and onnxruntime-web
 * are downloaded once, off the page's critical path, and never at all by a build using the
 * server engine.
 */

import { KokoroTTS, TextSplitterStream } from "kokoro-js";
import type { FromWorker, LoadProgress, ResolvedBackend, ToWorker } from "./protocol";

/**
 * `self` typed by hand rather than through `/// <reference lib="webworker" />`: that lib
 * redeclares half of `dom`, which the app's tsconfig needs everywhere else, and the two
 * cannot both be loaded in one program.
 */
const ctx = self as unknown as {
  postMessage(message: FromWorker, transfer?: Transferable[]): void;
  addEventListener(type: "message", listener: (event: MessageEvent<ToWorker>) => void): void;
};

/**
 * The rate the player's AudioBuffers are built at (`lib/audioPlayer.ts`). Kokoro emits
 * exactly this, and a model that did not would be played at the wrong pitch rather than
 * failing, so it is checked rather than trusted.
 */
const EXPECTED_SAMPLE_RATE = 24000;

let tts: KokoroTTS | null = null;
let loading: Promise<void> | null = null;

/** Utterances the page gave up on. Checked between sentences — see `speak`. */
const cancelled = new Set<number>();

/**
 * Serialises generation. The queue only ever asks for one utterance at a time, but the
 * "Test audio" buttons sit outside it, and two concurrent `generate` calls on one ONNX
 * session interleave into garbage rather than queueing.
 */
let chain: Promise<void> = Promise.resolve();

function post(message: FromWorker, transfer?: Transferable[]) {
  ctx.postMessage(message, transfer);
}

/* ── loading ─────────────────────────────────────────────────────────────────────────── */

/**
 * Resolves "auto" into something concrete.
 *
 * WebGPU is perhaps an order of magnitude faster than WASM here, but it is absent in
 * Firefox and Safari, and present-but-broken often enough that the request has to be tried
 * rather than merely feature-detected — hence `requestAdapter` before committing. The dtype
 * pairing is upstream's recommendation: fp32 on WebGPU (q8 is both slower and audibly worse
 * there), q8 on WASM, where fp32 would mean a 326 MB download for a CPU that cannot use the
 * extra precision fast enough to matter.
 */
async function pickBackend(
  device: "auto" | "wasm" | "webgpu",
  dtype: "auto" | "fp32" | "fp16" | "q8" | "q4" | "q4f16",
): Promise<{ device: "wasm" | "webgpu"; dtype: Exclude<typeof dtype, "auto"> }> {
  let resolvedDevice: "wasm" | "webgpu" = device === "auto" ? "wasm" : device;

  if (device === "auto") {
    const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
    if (gpu) {
      try {
        if (await gpu.requestAdapter()) resolvedDevice = "webgpu";
      } catch {
        /* no adapter, or the browser refused — WASM it is */
      }
    }
  }

  const resolvedDtype =
    dtype !== "auto" ? dtype : resolvedDevice === "webgpu" ? ("fp32" as const) : ("q8" as const);

  return { device: resolvedDevice, dtype: resolvedDtype };
}

/**
 * Turns transformers.js' per-file callbacks into one number.
 *
 * The hub hands out several files of wildly different sizes (the ONNX weights dwarf the
 * tokenizer), and each reports its own 0–100. Averaging those would sit at 50% for the
 * entire weights download, so this weights by bytes and only counts files whose total is
 * known. Files still arrive one at a time, so the figure can step rather than glide; that is
 * better than a bar that stalls.
 */
function makeProgressReporter() {
  const files = new Map<string, { loaded: number; total: number }>();
  let lastPercent = -1;

  return (data: {
    status?: string;
    file?: string;
    name?: string;
    loaded?: number;
    total?: number;
  }) => {
    const file = data.file ?? data.name ?? "";
    if (data.status === "progress" && file && typeof data.total === "number" && data.total > 0) {
      files.set(file, { loaded: data.loaded ?? 0, total: data.total });
    } else if (data.status === "done" && file) {
      const entry = files.get(file);
      if (entry) entry.loaded = entry.total;
    } else {
      return;
    }

    let loaded = 0;
    let total = 0;
    for (const entry of files.values()) {
      loaded += entry.loaded;
      total += entry.total;
    }
    if (total === 0) return;

    // Capped at 99: the download finishing is not the model being usable, and a bar that
    // reaches 100 and then sits there for the session warm-up reads as a hang.
    const percent = Math.min(99, Math.round((loaded / total) * 100));
    if (percent === lastPercent) return;
    lastPercent = percent;

    const progress: LoadProgress = {
      phase: "downloading",
      percent,
      detail: `${formatMb(loaded)} of ${formatMb(total)}`,
    };
    post({ type: "progress", progress });
  };
}

function formatMb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function load(modelId: string, device: "wasm" | "webgpu", dtype: string): Promise<KokoroTTS> {
  return KokoroTTS.from_pretrained(modelId, {
    dtype: dtype as "fp32" | "fp16" | "q8" | "q4" | "q4f16",
    device,
    progress_callback: makeProgressReporter(),
  });
}

/**
 * Loads the model, then proves it works by synthesising one short line.
 *
 * The warm-up is not decoration. Creating the inference session and compiling the graph is
 * a large part of the first utterance's latency, and the point at which a broken backend
 * actually throws — a WebGPU adapter that exists but cannot run the graph fails here, not
 * at `from_pretrained`. Doing it now means the failure lands on the setup screen with a
 * progress bar in front of it, and the fallback to WASM costs a streamer nothing but a
 * wait; doing it lazily means the first cheer of the stream is the one that discovers it.
 */
async function initialise(modelId: string, device: string, dtype: string): Promise<void> {
  const wanted = await pickBackend(
    device as "auto" | "wasm" | "webgpu",
    dtype as "auto" | "fp32" | "fp16" | "q8" | "q4" | "q4f16",
  );

  const backend: ResolvedBackend = { ...wanted, fellBackFrom: null };
  let model: KokoroTTS;

  try {
    model = await load(modelId, wanted.device, wanted.dtype);
    post({ type: "progress", progress: { phase: "warming", percent: 99, detail: "Warming up" } });
    await model.generate("Ready.", { voice: "af_sky" });
  } catch (err) {
    if (wanted.device !== "webgpu") throw err;
    // WebGPU was a guess (or an explicit choice on a machine that cannot honour it). WASM
    // works everywhere, so fall back rather than leaving the streamer with no speech.
    backend.fellBackFrom = `${wanted.device}/${wanted.dtype}: ${(err as Error).message}`;
    backend.device = "wasm";
    backend.dtype = dtype === "auto" ? "q8" : (dtype as typeof backend.dtype);
    post({
      type: "progress",
      progress: { phase: "downloading", percent: 0, detail: "WebGPU failed, retrying on CPU" },
    });
    model = await load(modelId, backend.device, backend.dtype);
    post({ type: "progress", progress: { phase: "warming", percent: 99, detail: "Warming up" } });
    await model.generate("Ready.", { voice: "af_sky" });
  }

  tts = model;
  post({ type: "ready", voices: Object.keys(model.voices), backend });
}

/* ── synthesis ───────────────────────────────────────────────────────────────────────── */

async function speak(msg: { id: number; text: string; voice: string; speed: number }) {
  const model = tts;
  if (!model) {
    post({ type: "failed", id: msg.id, detail: "The voice model is not loaded yet" });
    return;
  }
  if (cancelled.has(msg.id)) {
    cancelled.delete(msg.id);
    post({ type: "end", id: msg.id });
    return;
  }

  try {
    // Sentence at a time, so the first audio reaches the speakers while the rest of a long
    // message is still being generated — the same shape the FastAPI service streamed in,
    // and the reason a paragraph does not sit silent for ten seconds before it starts.
    //
    // **The splitter is built here and closed by hand rather than passing `msg.text`
    // straight to `stream`, and that is load-bearing.** Handed a string, kokoro-js builds
    // exactly this splitter and then never closes it — and `TextSplitterStream` holds back
    // a sentence whose terminator is the last thing in its buffer, because more text may
    // still be coming to prove it was an abbreviation rather than a full stop. Nothing ever
    // arrives, so the final sentence is never emitted and the iterator waits on a resolver
    // that will not fire. A one-sentence chat message therefore produces *no audio at all*
    // and hangs forever: the queue sits on "now speaking" with nothing playing, and because
    // the worker never returns from this loop, every later message queues behind it for the
    // rest of the session. Closing the stream flushes that held-back sentence and ends the
    // iteration.
    //
    // The cast on the options is the one unavoidable one here: kokoro-js types `voice` as a
    // union of its 28 literal ids, and this one arrives as a string from the queue. It has
    // already been matched against the list the worker reported at `ready`, and an id that
    // slipped through anyway throws inside `generate` and is reported as a failed utterance.
    const splitter = new TextSplitterStream();
    splitter.push(msg.text);
    splitter.close();

    const options = { voice: msg.voice, speed: msg.speed } as Parameters<KokoroTTS["stream"]>[1];
    const stream = model.stream(splitter, options);

    for await (const { audio } of stream) {
      if (cancelled.has(msg.id)) break;

      if (audio.sampling_rate !== EXPECTED_SAMPLE_RATE) {
        throw new Error(
          `Model returned ${audio.sampling_rate} Hz audio; the player is built for ${EXPECTED_SAMPLE_RATE} Hz`,
        );
      }

      // Copied when it is a view onto a larger buffer: the message transfers
      // `samples.buffer`, and transferring a shared one would hand away everything else
      // living in it as well.
      const raw = audio.audio as Float32Array;
      const samples =
        raw.byteOffset === 0 && raw.buffer.byteLength === raw.byteLength
          ? raw
          : new Float32Array(raw);

      post({ type: "chunk", id: msg.id, samples, sampleRate: audio.sampling_rate }, [
        samples.buffer as ArrayBuffer,
      ]);
    }

    post({ type: "end", id: msg.id });
  } catch (err) {
    post({ type: "failed", id: msg.id, detail: (err as Error).message });
  } finally {
    cancelled.delete(msg.id);
  }
}

/* ── message pump ────────────────────────────────────────────────────────────────────── */

ctx.addEventListener("message", (event) => {
  const msg = event.data;

  switch (msg.type) {
    case "init":
      // Deduped on the in-flight promise: several screens ask for voices on mount, and a
      // second `from_pretrained` would download and compile the whole model again.
      if (!loading) {
        loading = initialise(msg.modelId, msg.device, msg.dtype).catch((err: Error) => {
          loading = null; // a failed load is retryable; a cached rejection would not be
          post({ type: "initFailed", detail: err.message });
        });
      }
      break;

    case "speak":
      chain = chain.then(() => speak(msg));
      break;

    case "cancel":
      // Recorded rather than acted on: there is no way into a running inference. The loop
      // in `speak` checks this between sentences, so a skip takes effect at the next
      // sentence boundary at the latest — and the page has already silenced the player, so
      // nothing generated in the meantime is heard.
      cancelled.add(msg.id);
      break;
  }
});
