"use client";

/**
 * Browser half of the Kokoro client. Talks to this app's own /api/tts/* routes, never to
 * the TTS server directly — that server sends no CORS headers, so a direct fetch is blocked
 * before it leaves the page. See src/server/kokoro.ts.
 *
 * The paths go through `withBasePath`: Next's `basePath` does not rewrite bare fetch URLs,
 * so a literal "/api/tts/voices" reaches the proxy's root instead of the app once it is
 * mounted under a prefix. See lib/basePath.ts.
 */

import { withBasePath } from "./basePath";

/**
 * Mirror of the server's AccessDeniedError. `message` is always the same generic line;
 * `detail` carries the real cause and is the only way to tell a genuine whitelist rejection
 * from a routing or network fault, so every surface that shows the message should show the
 * detail underneath it.
 */
export class AccessDeniedError extends Error {
  readonly detail: string;
  constructor(detail: string) {
    super("You are not whitelisted. Reach out to Monatry.");
    this.name = "AccessDeniedError";
    this.detail = detail;
  }
}

async function toAccessDenied(res: Response, fallback: string): Promise<AccessDeniedError> {
  try {
    const body = (await res.json()) as { detail?: string; error?: string };
    return new AccessDeniedError(body.detail || body.error || fallback);
  } catch {
    return new AccessDeniedError(`${fallback} (HTTP ${res.status})`);
  }
}

export async function fetchVoices(signal?: AbortSignal): Promise<string[]> {
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

/** Opens the synthesis stream. The body is raw 24 kHz / 16-bit LE / mono PCM. */
export async function openPcmStream(
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
 * Rate divides the result, because that is exactly what the server's `speed` parameter does.
 */
export function estimateSeconds(text: string, rate: number): number {
  const FIXED_OVERHEAD = 0.3;
  const SECONDS_PER_CHAR = 0.06;
  const seconds = (FIXED_OVERHEAD + text.length * SECONDS_PER_CHAR) / (rate || 1);
  return Math.max(1, Math.round(seconds * 10) / 10);
}
