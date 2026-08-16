"use client";

import styles from "./Slider.module.css";

/**
 * The gold slider: 8px track on `#f0e6cd`, filled with the gold gradient, 22px white knob
 * with a 2px gold border.
 *
 * Built on a real `input[type=range]` rather than a drawn div, so arrow keys, Home/End and
 * screen readers work without reimplementing any of it. The fill is a background-size trick
 * on the input itself — the pseudo-element track cannot be split into filled and unfilled
 * halves in every engine.
 */
export function Slider({
  value,
  min,
  max,
  step,
  onChange,
  label,
  ariaValueText,
  disabled,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (next: number) => void;
  label: string;
  ariaValueText?: string;
  disabled?: boolean;
}) {
  const fill = max > min ? ((value - min) / (max - min)) * 100 : 0;
  return (
    <input
      type="range"
      className={styles.range}
      style={{ ["--fill" as string]: `${fill}%` }}
      value={value}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      aria-label={label}
      aria-valuetext={ariaValueText}
      onChange={(e) => onChange(Number(e.target.value))}
    />
  );
}
