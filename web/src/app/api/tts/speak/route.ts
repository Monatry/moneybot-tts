import { NextRequest, NextResponse } from "next/server";
import { AccessDeniedError, openSpeechStream } from "@/server/kokoro";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface SpeakBody {
  text?: unknown;
  voice?: unknown;
  speed?: unknown;
}

export async function POST(req: NextRequest) {
  let body: SpeakBody;
  try {
    body = (await req.json()) as SpeakBody;
  } catch {
    return NextResponse.json({ error: "Malformed request body" }, { status: 400 });
  }

  const text = typeof body.text === "string" ? body.text.trim() : "";
  const voice = typeof body.voice === "string" ? body.voice : "";
  const speed = typeof body.speed === "number" ? Math.min(2, Math.max(0.5, body.speed)) : 1;

  if (!text || !voice) {
    return NextResponse.json({ error: "text and voice are both required" }, { status: 400 });
  }

  try {
    // req.signal aborts when the browser cancels the fetch — which is exactly what Skip
    // does. Passing it through means a skipped message stops costing server time upstream
    // instead of synthesising to completion into a socket nobody is reading.
    const stream = await openSpeechStream({ text, voice, speed, signal: req.signal });
    return new Response(stream, {
      headers: {
        // Raw 24 kHz / 16-bit / mono PCM — no container, no header. The client reads it
        // as Int16 little-endian.
        "Content-Type": "application/octet-stream",
        "Cache-Control": "no-store",
        "X-Sample-Rate": "24000",
      },
    });
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      return new Response(null, { status: 499 });
    }
    if (err instanceof AccessDeniedError) {
      return NextResponse.json(
        { error: err.message, detail: err.detail },
        { status: err.status },
      );
    }
    return NextResponse.json(
      {
        error: "You are not whitelisted. Reach out to Monatry.",
        detail: (err as Error).message,
      },
      { status: 502 },
    );
  }
}
