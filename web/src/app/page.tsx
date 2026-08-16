"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { Coin } from "@/components/Coin";
import { useSettings, useSettingsReady } from "@/lib/settings";

/**
 * Entry router, per the handoff's navigation rule: login → (first run) setup → dashboard,
 * and returning users land straight on the dashboard.
 *
 * The redirect waits on `useSettingsReady` rather than firing on the first render. Settings
 * live in localStorage, which the server render cannot see — acting on the pre-hydration
 * value would bounce every returning streamer through the login screen.
 */
export default function Home() {
  const router = useRouter();
  const ready = useSettingsReady();
  const settings = useSettings();

  useEffect(() => {
    if (!ready) return;
    if (settings.setupComplete) router.replace("/dashboard");
    else if (settings.auth.channel) router.replace("/setup");
    else router.replace("/login");
  }, [ready, settings.setupComplete, settings.auth.channel, router]);

  return (
    <main
      style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        background: "var(--color-surface)",
      }}
    >
      <Coin size={46} bounce />
    </main>
  );
}
