"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Coin } from "@/components/Coin";
import { GithubGlyph, SOURCE_URL } from "@/components/GithubGlyph";
import { TwitchGlyph } from "@/components/TwitchGlyph";
import { updateSettings, useSettings } from "@/lib/settings";
import { normalizeToken } from "@/lib/twitchAuth";
import { useTwitchSignIn } from "@/lib/useTwitchSignIn";
import styles from "./login.module.css";

/** Screen 1a — authenticate, either via Twitch OAuth or by pasting a channel + token. */
export default function LoginPage() {
  const router = useRouter();
  const settings = useSettings();
  const [channel, setChannel] = useState("");
  const [token, setToken] = useState("");
  const [tokenError, setTokenError] = useState<string | null>(null);

  const signIn = useTwitchSignIn(() => {
    router.push(settings.setupComplete ? "/dashboard" : "/setup");
  });

  // The design gates the secondary CTA on a non-empty channel and an `oauth:`-prefixed
  // token; both are checked again on submit so a paste that fails validation shows the
  // inline error rather than silently doing nothing.
  const tokenLooksRight = /^oauth:\S+/i.test(token.trim());
  const canSubmitToken = channel.trim().length > 0 && tokenLooksRight;

  async function submitToken(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmitToken) {
      setTokenError(
        tokenLooksRight
          ? "Enter the channel to read chat from."
          : "Paste the whole token, including the oauth: prefix.",
      );
      return;
    }
    setTokenError(null);
    // Stored before validation so the token flow and the OAuth flow agree on which channel
    // is being watched; `applyToken` only fills it in when it is still blank.
    updateSettings((prev) => ({
      ...prev,
      auth: { ...prev.auth, channel: channel.trim().toLowerCase() },
    }));
    const ok = await signIn.applyToken(normalizeToken(token));
    if (!ok) setTokenError("Twitch rejected that token: it is invalid or expired.");
  }

  return (
    <main className={styles.page}>
      <div className={styles.circleTop} aria-hidden />
      <div className={styles.circleBottom} aria-hidden />

      <section className={styles.left}>
        <div className={styles.brand}>
          <Coin size={46} />
          <span className={styles.wordmark}>Moneybot TTS</span>
        </div>

        <div className={styles.hero}>
          <h1 className={styles.heroTitle}>
            Let the chat
            <br />
            talk back.
          </h1>
          <p className={styles.heroBody}>
            Read out chat, cheers and channel-point redeems in one tidy voice queue, with an
            avatar that moves while it speaks.
          </p>
          <div className={styles.pills}>
            <span className="tag tag-accent">Cheers → speech</span>
            <span className="tag tag-accent-2">Channel points</span>
            <span className="tag tag-neutral">Avatar overlay</span>
          </div>
        </div>

        <div className={styles.footerMeta}>
          <span>Status: all systems live</span>
          <span>·</span>
          <span>v2.4</span>
        </div>
      </section>

      <section className={styles.right}>
        <div>
          <h3 style={{ margin: "0 0 6px" }}>Sign in</h3>
          <p className={styles.signInNote}>
            Moneybot only ever reads your chat. It never posts as you.
          </p>
        </div>

        <button
          type="button"
          className={`btn btn-twitch ${styles.twitchCta}`}
          onClick={signIn.signIn}
          disabled={signIn.busy}
        >
          <TwitchGlyph size={18} />
          {signIn.busy ? "Waiting for Twitch…" : "Continue with Twitch"}
        </button>

        {signIn.error && <p className="error-line">{signIn.error}</p>}

        <div className={styles.or}>
          <span className={styles.orRule} />
          OR
          <span className={styles.orRule} />
        </div>

        <form className={styles.form} onSubmit={submitToken}>
          <div className="field">
            <label htmlFor="channel">Channel name</label>
            <input
              id="channel"
              className={`input ${styles.tallInput}`}
              value={channel}
              onChange={(e) => setChannel(e.target.value)}
              placeholder="moneybot_demo"
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <div className="field">
            <label htmlFor="token">OAuth token</label>
            <input
              id="token"
              className={`input ${styles.tallInput}`}
              type="password"
              value={token}
              onChange={(e) => {
                setToken(e.target.value);
                setTokenError(null);
              }}
              placeholder="oauth:••••••••••••••••••"
              autoComplete="off"
              spellCheck={false}
            />
            {tokenError && <p className="error-line">{tokenError}</p>}
          </div>
          <button type="submit" className={`btn btn-primary ${styles.tokenCta}`} disabled={signIn.busy}>
            Sign in with token
          </button>
        </form>

        <p className={styles.help}>
          Trouble signing in?{" "}
          <a
            href="https://dev.twitch.tv/docs/authentication/"
            target="_blank"
            rel="noreferrer noopener"
          >
            Read the setup guide
          </a>
        </p>

        {/* This screen has no nav to hang the source mark off, so it takes the panel's own
            corner — out of the centred column, at the same weight as the meta line opposite. */}
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
      </section>
    </main>
  );
}
