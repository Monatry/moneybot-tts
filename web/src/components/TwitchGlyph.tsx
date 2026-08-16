/**
 * The Twitch mark. Lucide has no brand icons, and the design's login CTA draws one with a
 * clip-path placeholder — this is the real silhouette at the same weight.
 */
export function TwitchGlyph({ size = 18, color = "currentColor" }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={color} aria-hidden focusable="false">
      <path d="M4.3 2 2.5 6.5V20h5v3h3l3-3h4l5.5-5.5V2H4.3Zm15.7 11.5-3 3h-4l-3 3v-3H6V4h14v9.5Z" />
      <path d="M17.5 7h-2v5h2V7ZM12 7h-2v5h2V7Z" />
    </svg>
  );
}
