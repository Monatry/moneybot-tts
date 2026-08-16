import type { Metadata, Viewport } from "next";
import { Caprasimo, Figtree } from "next/font/google";
import "./globals.css";

/*
 * Caprasimo for display, Figtree for body — the two faces the design system names. They are
 * exposed as the same CSS variables the handoff's stylesheet used, so globals.css and every
 * module below it can go on referring to --font-heading / --font-body.
 */
const caprasimo = Caprasimo({
  weight: "400",
  subsets: ["latin"],
  variable: "--font-heading",
  display: "swap",
});

const figtree = Figtree({
  weight: ["400", "600", "700"],
  subsets: ["latin"],
  variable: "--font-body",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Moneybot TTS",
  description:
    "Read out chat, cheers and channel-point redeems in one tidy voice queue, with an avatar that moves while it speaks.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${caprasimo.variable} ${figtree.variable}`}>
      <body>{children}</body>
    </html>
  );
}
