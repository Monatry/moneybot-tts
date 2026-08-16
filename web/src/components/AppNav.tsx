import Link from "next/link";
import { Coin } from "./Coin";
import { GithubGlyph, SOURCE_URL } from "./GithubGlyph";
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
      {/* Always rendered, `right` or not: the source mark is what holds the far corner, and
          it sits after the screen's own controls so it never leads them. */}
      <div className={styles.right}>
        {right}
        <a
          className={styles.source}
          href={SOURCE_URL}
          target="_blank"
          rel="noreferrer noopener"
          title="Source on GitHub"
          aria-label="Source on GitHub"
        >
          <GithubGlyph size={18} />
        </a>
      </div>
    </nav>
  );
}
