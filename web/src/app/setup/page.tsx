"use client";

import { useRouter } from "next/navigation";
import { useSettings } from "@/lib/settings";
import { TriggersAudio } from "./TriggersAudio";

/**
 * Screen 1c. Setup is a single screen: `/` already captures the channel and the token when
 * a streamer signs in there, so preferences are all that is left to ask on a first run.
 */
export default function SetupPage() {
  const router = useRouter();
  const settings = useSettings();

  return (
    <TriggersAudio
      tokenMissing={!settings.auth.token}
      onFinish={() => router.push("/dashboard")}
    />
  );
}
