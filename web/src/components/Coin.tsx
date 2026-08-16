import styles from "./Coin.module.css";

/**
 * The `$` coin mark. Placeholder brand: the handoff is explicit that it is CSS-drawn
 * stand-in art to be swapped for a real mark when one exists.
 *
 * `size` drives everything — the glyph is a fixed fraction of the diameter, so a 28px nav
 * coin and a 92px preview coin are the same drawing.
 *
 * `src/app/icon.svg` is the same mark redrawn as a vector for the favicon (a favicon renders
 * outside the document, so it can neither share this CSS nor use the webfont). Restyle both.
 */
export function Coin({
  size = 30,
  shadow = 3,
  tone = "gold",
  className,
  bounce = false,
}: {
  size?: number;
  /** Depth of the solid "stacked coin" drop shadow. 0 removes it. */
  shadow?: number;
  /** `gold` is the brand mark; `white` is the now-speaking card's inverted version. */
  tone?: "gold" | "white";
  className?: string;
  bounce?: boolean;
}) {
  return (
    <span
      className={[styles.coin, bounce ? styles.bounce : "", className ?? ""]
        .filter(Boolean)
        .join(" ")}
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.47),
        background:
          tone === "white" ? "#fff" : "linear-gradient(150deg,#f0d888,#c8a02a)",
        color: tone === "white" ? "#a5811b" : "#5b450f",
        boxShadow: shadow > 0 ? `0 ${shadow}px 0 ${tone === "white" ? "#dfbc4c" : "#a5811b"}` : "none",
      }}
      aria-hidden
    >
      $
    </span>
  );
}
