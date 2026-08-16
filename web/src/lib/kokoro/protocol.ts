/**
 * The wire format between the page and the Kokoro worker.
 *
 * Its own module, imported by both sides, so the worker's heavy dependency graph
 * (kokoro-js pulls in transformers.js and onnxruntime-web — several megabytes) never
 * reaches the page bundle. The page imports *types* from here and nothing else, and the
 * worker chunk is fetched only when a build with the browser engine actually starts
 * loading the model.
 */

/** Where inference runs. "auto" resolves in the worker — see `pickBackend`. */
export type LocalTtsDevice = "auto" | "wasm" | "webgpu";

/** Weight precision. "auto" pairs fp32 with WebGPU and q8 with WASM. */
export type LocalTtsDtype = "auto" | "fp32" | "fp16" | "q8" | "q4" | "q4f16";

/** What the worker actually settled on, which is not always what was asked for. */
export interface ResolvedBackend {
  device: "wasm" | "webgpu";
  dtype: Exclude<LocalTtsDtype, "auto">;
  /** Set when the requested backend failed and the worker fell back to another. */
  fellBackFrom: string | null;
}

export interface InitMessage {
  type: "init";
  modelId: string;
  device: LocalTtsDevice;
  dtype: LocalTtsDtype;
}

export interface SpeakMessage {
  type: "speak";
  id: number;
  text: string;
  voice: string;
  speed: number;
}

/** Stop generating for one utterance. The worker finishes the sentence it is mid-way
 *  through — the model has no mid-inference abort — and emits nothing further. */
export interface CancelMessage {
  type: "cancel";
  id: number;
}

export type ToWorker = InitMessage | SpeakMessage | CancelMessage;

export interface LoadProgress {
  /** "downloading" covers the weights and the tokenizer; "warming" is the first
   *  inference session being created, which on WASM takes a few seconds with no
   *  byte counter to report against. */
  phase: "downloading" | "warming";
  /** 0–100. Aggregated across every file the hub hands out, weighted by byte count. */
  percent: number;
  detail: string;
}

export type FromWorker =
  | { type: "progress"; progress: LoadProgress }
  | { type: "ready"; voices: string[]; backend: ResolvedBackend }
  | { type: "initFailed"; detail: string }
  /** One sentence of audio. `samples` is transferred, so the worker no longer owns it. */
  | { type: "chunk"; id: number; samples: Float32Array; sampleRate: number }
  | { type: "end"; id: number }
  | { type: "failed"; id: number; detail: string };
