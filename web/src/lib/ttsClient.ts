"use client";

/**
 * The app's one door to synthesis, and the seam between the two engines.
 *
 * Which one is behind it is decided by `NEXT_PUBLIC_TTS_ENGINE` at build time, or by
 * `forceEngine` for a page that has to differ (lib/ttsEngine.ts). Nothing above this file
 * knows which it got — `ttsQueue` reads chunks off a reader either way:
 *
 *   "server"  — POST to this app's own /api/tts/*, which relays a Kokoro instance of
 *               ../server. That server sends no CORS headers, so a browser fetch to it
 *               would be blocked before it left the page; the proxy exists for that reason
 *               alone. Chunks are raw 16-bit PCM bytes.
 *   "browser" — kokoro-js in a worker on this machine (lib/kokoro/*). No network at
 *               synthesis time at all. Chunks are float samples, one sentence each.
 *
 * The paths go through `withBasePath`: Next's `basePath` does not rewrite bare fetch URLs,
 * so a literal "/api/tts/voices" reaches the proxy's root instead of the app once it is
 * mounted under a prefix. See lib/basePath.ts.
 */

import { withBasePath } from "./basePath";
import * as localTts from "./kokoro/localTts";
import { activeEngine } from "./ttsEngine";

/**
 * Mirror of the server's AccessDeniedError. `message` is always the same generic line;
 * `detail` carries the real cause and is the only way to tell a genuine whitelist rejection
 * from a routing or network fault, so every surface that shows the message should show the
 * detail underneath it.
 *
 * Server engine only. The browser engine throws `LocalTtsError`, which carries `detail` the
 * same way — everything that renders one renders the other.
 */
export class AccessDeniedError extends Error {
  readonly detail: string;
  constructor(detail: string) {
    super("You are not whitelisted. Reach out to Monatry.");
    this.name = "AccessDeniedError";
    this.detail = detail;
  }
}

export { LocalTtsError } from "./kokoro/localTts";

/** Any synthesis failure worth showing: both engines' errors carry a `detail`. */
export interface TtsFailure extends Error {
  detail?: string;
}

/* ── engine status, for the UI ───────────────────────────────────────────────────────── */

export interface EngineStatus {
  /** "unused" on the server engine, whose readiness is a property of a box elsewhere. */
  phase: "unused" | "idle" | "loading" | "ready" | "error";
  percent: number;
  detail: string;
  /** Browser engine, once ready: what it settled on, e.g. webgpu/fp32. */
  backend: { device: string; dtype: string; fellBackFrom: string | null } | null;
}

const UNUSED: EngineStatus = { phase: "unused", percent: 0, detail: "", backend: null };

export function getEngineStatus(): EngineStatus {
  return activeEngine() === "browser" ? localTts.getStatus() : UNUSED;
}

/** No-op on the server engine, so callers need no branch of their own. */
export function subscribeEngineStatus(listener: (status: EngineStatus) => void): () => void {
  if (activeEngine() !== "browser") return () => {};
  return localTts.subscribeStatus(listener);
}

/**
 * Throws away the loaded model so the next call reloads it. Browser engine only; the
 * device and precision controls on the setup screen are the only callers, because an ONNX
 * session cannot be re-targeted once it exists.
 */
export function resetEngine() {
  if (activeEngine() === "browser") localTts.reset();
}

/* ── the two calls that matter ───────────────────────────────────────────────────────── */

async function toAccessDenied(res: Response, fallback: string): Promise<AccessDeniedError> {
  try {
    const body = (await res.json()) as { detail?: string; error?: string };
    return new AccessDeniedError(body.detail || body.error || fallback);
  } catch {
    return new AccessDeniedError(`${fallback} (HTTP ${res.status})`);
  }
}

export async function fetchVoices(signal?: AbortSignal): Promise<string[]> {
  if (activeEngine() === "browser") {
    // Loads the model as a side effect — the voice list is a property of the weights, and
    // there is nothing to ask before they are here. Callers show `subscribeEngineStatus`
    // while this is outstanding; it is tens of seconds on a cold cache.
    return localTts.loadVoices();
  }

  let res: Response;
  try {
    res = await fetch(withBasePath("/api/tts/voices"), { signal, cache: "no-store" });
  } catch (err) {
    throw new AccessDeniedError(`Could not reach this app's server: ${(err as Error).message}`);
  }
  if (!res.ok) throw await toAccessDenied(res, "Voice list request failed");
  const body = (await res.json()) as { voices?: string[] };
  const voices = body.voices ?? [];
  if (voices.length === 0) throw new AccessDeniedError("Server returned an empty voice list");
  return voices;
}

/**
 * Opens the synthesis stream.
 *
 * The chunk type is the one thing the two engines do not agree on, and it is left that way
 * on purpose rather than converted here: the server sends raw 24 kHz / 16-bit LE / mono PCM
 * bytes, which arrive split at arbitrary offsets and have to be re-joined a sample at a
 * time, while kokoro-js hands back whole sentences of float samples that are already the
 * shape an AudioBuffer wants. `PcmPlayer.push` takes either and the conversion happens where
 * the samples land, so neither engine pays for the other's format.
 */
export function openPcmStream(
  text: string,
  voice: string,
  speed: number,
  signal?: AbortSignal,
): Promise<ReadableStreamDefaultReader<Uint8Array | Float32Array>> {
  if (activeEngine() === "browser") return localTts.openPcmStream(text, voice, speed, signal);
  return openServerPcmStream(text, voice, speed, signal);
}

async function openServerPcmStream(
  text: string,
  voice: string,
  speed: number,
  signal?: AbortSignal,
): Promise<ReadableStreamDefaultReader<Uint8Array>> {
  const res = await fetch(withBasePath("/api/tts/speak"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, voice, speed }),
    signal,
  });
  if (!res.ok) throw await toAccessDenied(res, "Synthesis request failed");
  if (!res.body) throw new AccessDeniedError("Synthesis response had no body");
  return res.body.getReader();
}

/**
 * Rough seconds of speech for a line of text, used for the queue's per-row duration and the
 * "6 waiting · 1m 12s" total. There is no way to know the real length without synthesising,
 * so this is a linear fit over three lines measured against this server at speed 1.0:
 *
 *     11 chars → 1.15 s     53 chars → 3.18 s     101 chars → 6.55 s
 *
 * Least squares over those gives ~0.06 s per character with a ~0.3 s fixed offset — the
 * offset is the lead-in and tail every utterance carries regardless of length, which is why
 * a pure characters-per-second figure under-reads short lines badly. Predictions land within
 * about 10% across the range, which is all a queue estimate needs.
 *
 * It holds for both engines: the fit is over the *speech* the model produces, and it is the
 * same model either side of the seam. How long the machine takes to generate it does not
 * come into it.
 *
 * Rate divides the result, because that is exactly what the `speed` parameter does.
 */
export function estimateSeconds(text: string, rate: number): number {
  const FIXED_OVERHEAD = 0.3;
  const SECONDS_PER_CHAR = 0.06;
  const seconds = (FIXED_OVERHEAD + text.length * SECONDS_PER_CHAR) / (rate || 1);
  return Math.max(1, Math.round(seconds * 10) / 10);
}
