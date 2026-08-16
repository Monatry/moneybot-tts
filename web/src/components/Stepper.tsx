"use client";

import { Minus, Plus } from "lucide-react";
import styles from "./Stepper.module.css";

/**
 * The minimum-bits stepper: value in the heading font between two round gold buttons.
 *
 * The number is an editable input, not just a readout — typing 500 is faster than
 * twenty-five presses of `+`, and the design's own range for this field is 0–100000.
 */
export function Stepper({
  value,
  onChange,
  min,
  max,
  step = 10,
  label,
  disabled,
}: {
  value: number;
  onChange: (next: number) => void;
  min: number;
  max: number;
  step?: number;
  label: string;
  disabled?: boolean;
}) {
  const clamp = (n: number) => Math.min(max, Math.max(min, Math.round(n)));

  return (
    <div className={styles.stepper} data-disabled={disabled || undefined}>
      <input
        className={styles.value}
        type="text"
        inputMode="numeric"
        value={value}
        disabled={disabled}
        aria-label={label}
        size={Math.max(2, String(value).length)}
        onChange={(e) => {
          const parsed = Number.parseInt(e.target.value.replace(/\D/g, ""), 10);
          onChange(Number.isNaN(parsed) ? min : clamp(parsed));
        }}
      />
      <div className={styles.buttons}>
        <button
          type="button"
          className={styles.btn}
          disabled={disabled || value <= min}
          aria-label={`Decrease ${label}`}
          onClick={() => onChange(clamp(value - step))}
        >
          <Minus size={13} strokeWidth={2.75} />
        </button>
        <button
          type="button"
          className={styles.btn}
          disabled={disabled || value >= max}
          aria-label={`Increase ${label}`}
          onClick={() => onChange(clamp(value + step))}
        >
          <Plus size={13} strokeWidth={2.75} />
        </button>
      </div>
    </div>
  );
}
