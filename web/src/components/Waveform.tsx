"use client";

import styles from "./Waveform.module.css";

/** Resting heights, straight from the design's test card. */
const BARS = [38, 72, 100, 64, 88, 30, 54, 22];
const TONES = ["#f7e9b9", "#efd582", "#c8a02a", "#efd582", "#c8a02a", "#f7e9b9", "#efd582", "#f7e9b9"];

/**
 * The gold bar waveform on the audio test card. Decorative — it is not driven by an
 * analyser, it just animates while something is speaking, which is all the design asks of
 * it ("animates the waveform bars").
 */
export function Waveform({ active = false, height = 38 }: { active?: boolean; height?: number }) {
  return (
    <div className={styles.wave} style={{ height }} aria-hidden>
      {BARS.map((h, i) => (
        <span
          key={i}
          className={active ? styles.barActive : styles.bar}
          style={{
            height: `${h}%`,
            background: TONES[i],
            animationDelay: `${i * 90}ms`,
          }}
        />
      ))}
    </div>
  );
}

/** The four-bar version pinned to the bottom of the avatar talking preview. */
export function MiniWaveform({ active = true }: { active?: boolean }) {
  const heights = [12, 20, 9, 16];
  const tones = ["#c8a02a", "#dfbc4c", "#efd582", "#dfbc4c"];
  return (
    <div className={styles.mini} aria-hidden>
      {heights.map((h, i) => (
        <span
          key={i}
          className={active ? styles.miniBarActive : styles.miniBar}
          style={{ height: h, background: tones[i], animationDelay: `${i * 110}ms` }}
        />
      ))}
    </div>
  );
}
