"use client";

import styles from "./Segmented.module.css";

/** The design system's `.seg` control: selected option is a gold fill with a white label. */
export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  name,
  label,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (next: T) => void;
  name: string;
  label: string;
}) {
  return (
    <div className={styles.seg} role="radiogroup" aria-label={label}>
      {options.map((opt) => (
        <label
          key={String(opt.value)}
          className={styles.opt}
          data-selected={opt.value === value || undefined}
        >
          <input
            type="radio"
            name={name}
            checked={opt.value === value}
            onChange={() => onChange(opt.value)}
          />
          <span>{opt.label}</span>
        </label>
      ))}
    </div>
  );
}
