import { NextResponse } from "next/server";
import { AccessDeniedError, loadVoices } from "@/server/kokoro";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const voices = await loadVoices();
    return NextResponse.json({ voices }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
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
