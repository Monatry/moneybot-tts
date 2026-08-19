/**
 * Which synthesiser this build talks to. Baked in at build time from
 * `NEXT_PUBLIC_TTS_ENGINE`, exactly like `NEXT_PUBLIC_BASE_PATH` — changing it means
 * rebuilding the image, not restarting the container.
 *
 *   "server"  — the original: POST to this app's /api/tts/*, which relays a Kokoro
 *               instance of ../server. Needs TTS_BASE_URL and a reachable box.
 *   "browser" — Kokoro runs in the streamer's own browser through kokoro-js, in a
 *               worker. No TTS server, no /api/tts traffic, nothing leaves the machine
 *               except the one-time model download from the Hugging Face CDN.
 *
 * Two builds rather than a runtime toggle because the choice decides what the *deployment*
 * is: the server build needs an upstream host configured and a private, whitelisted
 * audience; the browser build needs neither and can sit on a public URL. A runtime switch
 * would mean shipping a container that is half-configured for whichever half is off.
 *
 * The default is "server", so an existing build with the variable unset keeps behaving
 * exactly as it did.
 *
 * There is exactly one exception to "build time", and it is one-way — see `forceEngine`.
 */

export type TtsEngine = "server" | "browser";

export const TTS_ENGINE: TtsEngine =
  process.env.NEXT_PUBLIC_TTS_ENGINE === "browser" ? "browser" : "server";

/** Convenience for the many `if` sites. Folds to a literal at build time. */
export const IS_BROWSER_ENGINE = TTS_ENGINE === "browser";

/**
 * The runtime override, and the one place the build-time constant is not the last word.
 *
 * It exists for the OBS overlay running as its own client (lib/avatarRunner.ts). OBS's CEF
 * has no WebGPU and its WASM throughput is too low to synthesise a chat message in
 * reasonable time, so an overlay on a browser-engine build would be unusable — but it can
 * perfectly well POST to /api/tts/*, which is the same code path the server-engine build
 * uses and which ships in both images. So the overlay forces "server" for itself, and
 * nothing else in the bundle changes.
 *
 * One-way and once: an engine choice is read by a worker, an ONNX session and a fetch path
 * that are all built lazily on first use, so flipping it back after synthesis has begun
 * would leave half the app pointed the other way. `forceEngine` is therefore called before
 * `bot.start()` and never unset.
 */
let forced: TtsEngine | null = null;

/** Points this *page* at an engine, whatever the build says. Call before any synthesis. */
export function forceEngine(engine: TtsEngine): void {
  forced = engine;
}

/** The engine actually in use here: the override if one was set, else the build's. */
export function activeEngine(): TtsEngine {
  return forced ?? TTS_ENGINE;
}

/**
 * The Hugging Face repo the browser engine loads weights from. Overridable so a fork can
 * point at a mirror or a newer conversion without a source change; the default is the
 * ONNX community's conversion of Kokoro 82M v1.0, which is the one kokoro-js is built
 * against and the one its bundled voice ids match.
 */
export const KOKORO_MODEL_ID =
  process.env.NEXT_PUBLIC_KOKORO_MODEL_ID || "onnx-community/Kokoro-82M-v1.0-ONNX";
