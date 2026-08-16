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
 */

export type TtsEngine = "server" | "browser";

export const TTS_ENGINE: TtsEngine =
  process.env.NEXT_PUBLIC_TTS_ENGINE === "browser" ? "browser" : "server";

/** Convenience for the many `if` sites. Folds to a literal at build time. */
export const IS_BROWSER_ENGINE = TTS_ENGINE === "browser";

/**
 * The Hugging Face repo the browser engine loads weights from. Overridable so a fork can
 * point at a mirror or a newer conversion without a source change; the default is the
 * ONNX community's conversion of Kokoro 82M v1.0, which is the one kokoro-js is built
 * against and the one its bundled voice ids match.
 */
export const KOKORO_MODEL_ID =
  process.env.NEXT_PUBLIC_KOKORO_MODEL_ID || "onnx-community/Kokoro-82M-v1.0-ONNX";
