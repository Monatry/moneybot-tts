import type { Metadata } from "next";

/*
 * Exists only to name the tab. The overlay page itself is a client component, so it cannot
 * export `metadata` — and a streamer typically has this open as a browser source *and* as a
 * loose window next to the dashboard, where two tabs both reading "Moneybot TTS" is the
 * thing that gets closed by mistake.
 */
export const metadata: Metadata = {
  title: "Avatar overlay · Moneybot TTS",
};

export default function AvatarLayout({ children }: { children: React.ReactNode }) {
  return children;
}
