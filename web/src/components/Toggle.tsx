"use client";

import styles from "./Toggle.module.css";

/**
 * The pill switch. Gold everywhere except channel points, which the design keeps Twitch
 * purple — purple is reserved strictly for Twitch-owned concepts.
 *
 * A real checkbox underneath: it has to be reachable by keyboard and announce its state,
 * and the drawn pill is a label wrapping it.
 */
export function Toggle({
  checked,
  onChange,
  tone = "gold",
  size = "lg",
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  tone?: "gold" | "purple";
  size?: "lg" | "sm";
  /** Accessible name. Visually hidden — the row's own title is what the eye reads. */
  label: string;
  disabled?: boolean;
}) {
  return (
    <label
      className={[styles.wrap, styles[size], checked ? styles.on : styles.off, styles[tone]].join(
        " ",
      )}
      data-disabled={disabled || undefined}
    >
      <input
        type="checkbox"
        className={styles.input}
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className={styles.track}>
        <span className={styles.knob} />
      </span>
      <span className={styles.srOnly}>{label}</span>
    </label>
  );
}
