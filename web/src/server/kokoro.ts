import "server-only";

/**
 * Server-side half of the Kokoro TTS client. Everything about the upstream contract is
 * carried over verbatim from the desktop `KokoroTtsService`.
 *
 * The upstream host is **configuration, not a constant**: it comes from `TTS_BASE_URL`, and
 * there is deliberately no default. This app has no business guessing a host, and a wrong
 * guess would send a streamer's chat to somebody else's box, so an unset variable is a loud
 * failure rather than a fallback. Point it at any instance of the `server/` service in this
 * repo.
 *
 * It stays on the server rather than in the browser bundle for one hard reason on top of
 * that: the server sends no `Access-Control-Allow-Origin`, so a direct fetch from a page is
 * blocked before it is even sent. Every call goes through /api/tts/* instead. The variable
 * is deliberately not `NEXT_PUBLIC_*`, so it never reaches the client.
 *
 * The `/tts` prefix is part of the base: the server's OpenAPI doc declares
 * `servers: [{ url: "/tts" }]` and its paths hang off that.
 *
 *   GET  {TTS_BASE_URL}/voices  → { default, count, voices[] }
 *   POST {TTS_BASE_URL}/tts     → audio stream
 *   GET  {TTS_BASE_URL}/health  → { status, sample_rate: 24000, voices }
 *
 * The doubled /tts/tts is correct. POSTing to {TTS_BASE_URL} returns 301 to http://…/tts/, and
 * because that Location downgrades https→http, fetch refuses to follow it and the 301
 * surfaces as a request failure.
 */

const VOICES_TIMEOUT_MS = 10_000;

/** The sample rate the server reports from /health, and the rate the PCM stream is in. */
export const SAMPLE_RATE = 24000;

/**
 * Every connection failure and non-2xx response becomes this. `message` is always the same
 * generic line, deliberately — but the exception also carries `detail` with the real cause,
 * because that is the only way to tell a genuine whitelist rejection from a routing or
 * network fault. Always populate `detail` when throwing.
 */
export class AccessDeniedError extends Error {
  readonly detail: string;
  readonly status: number;

  constructor(detail: string, status = 502) {
    super("You are not whitelisted. Reach out to Monatry.");
    this.name = "AccessDeniedError";
    this.detail = detail;
    this.status = status;
  }
}

/**
 * The upstream base URL, read per call rather than once at module scope: `next build`
 * imports this module without the runtime environment, so evaluating it at the top level
 * would fail the Docker build instead of the request. Unset surfaces as an
 * `AccessDeniedError` whose `detail` names the variable, which is what `detail` is for.
 */
function baseUrl(): string {
  const url = process.env.TTS_BASE_URL;
  if (!url) {
    throw new AccessDeniedError("TTS_BASE_URL is not set on the server", 500);
  }
  return url.replace(/\/+$/, "");
}

export async function loadVoices(): Promise<string[]> {
  const url = `${baseUrl()}/voices`;
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { "User-Agent": "MoneybotTTS/2.4" },
      signal: AbortSignal.timeout(VOICES_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (err) {
    const e = err as Error;
    if (e.name === "TimeoutError" || e.name === "AbortError") {
      throw new AccessDeniedError(
        `Timed out after ${VOICES_TIMEOUT_MS / 1000}s reaching ${url}`,
        504,
      );
    }
    throw new AccessDeniedError(`Cannot reach ${url}: ${e.message}`);
  }

  if (response.status === 401 || response.status === 403) {
    throw new AccessDeniedError(`Server rejected this client (${response.status})`, 403);
  }
  if (!response.ok) {
    throw new AccessDeniedError(
      `Server returned ${response.status} ${response.statusText} for ${url}`,
    );
  }

  const body = (await response.json()) as { voices?: unknown };
  const voices = Array.isArray(body.voices)
    ? body.voices.filter((v): v is string => typeof v === "string" && v.length > 0)
    : [];

  if (voices.length === 0) {
    throw new AccessDeniedError(`Server returned an empty voice list from ${url}`);
  }
  return voices;
}

export interface SpeakOptions {
  text: string;
  voice: string;
  speed: number;
  signal?: AbortSignal;
}

/**
 * Opens the synthesis stream and hands back the raw upstream body.
 *
 * `format: "pcm"` is not optional. The server's default is `wav`, which prepends a 44-byte
 * RIFF header — the browser player feeds these bytes straight into an AudioBuffer as raw
 * 24 kHz / 16-bit / mono samples, so a header would be played as audio.
 */
export async function openSpeechStream(opts: SpeakOptions): Promise<ReadableStream<Uint8Array>> {
  const url = `${baseUrl()}/tts`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "MoneybotTTS/2.4" },
      body: JSON.stringify({
        text: opts.text,
        voice: opts.voice,
        speed: opts.speed,
        format: "pcm",
      }),
      signal: opts.signal,
      cache: "no-store",
    });
  } catch (err) {
    const e = err as Error;
    if (e.name === "AbortError") throw e;
    throw new AccessDeniedError(`Cannot reach ${url}: ${e.message}`);
  }

  if (response.status === 403 || response.status === 401) {
    throw new AccessDeniedError(`Server rejected this client (${response.status})`, 403);
  }
  if (!response.ok) {
    // 422 carries a validation body worth showing (bad voice id, speed out of range).
    let detail = await response.text().catch(() => "");
    if (detail.length > 300) detail = detail.slice(0, 300);
    throw new AccessDeniedError(
      `POST ${url} failed: ${response.status} ${response.statusText}. ${detail}`.trim(),
      response.status,
    );
  }
  if (!response.body) {
    throw new AccessDeniedError(`POST ${url} returned no body`);
  }
  return response.body;
}
