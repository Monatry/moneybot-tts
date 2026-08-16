import Link from "next/link";
import { Coin } from "./Coin";
import styles from "./AppNav.module.css";

/** The top bar shared by setup, the dashboard and avatar configuration. */
export function AppNav({
  coinSize = 28,
  children,
  right,
  compact,
}: {
  coinSize?: number;
  /** Sits next to the brand — status pills, back links. */
  children?: React.ReactNode;
  /** Pushed to the far right. */
  right?: React.ReactNode;
  compact?: boolean;
}) {
  return (
    <nav className={`nav ${styles.nav}`} style={{ padding: compact ? "16px 28px" : "18px 32px" }}>
      <Link href="/dashboard" className={`nav-brand ${styles.brand}`}>
        <Coin size={coinSize} shadow={0} />
        Moneybot TTS
      </Link>
      {children}
      {right && <div className={styles.right}>{right}</div>}
    </nav>
  );
}
