"use client";

import { Check, MessageSquare, Play, Square, Star } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Coin } from "@/components/Coin";
import { GithubGlyph, SOURCE_URL } from "@/components/GithubGlyph";
import { TwitchGlyph } from "@/components/TwitchGlyph";
import { withBasePath } from "@/lib/basePath";
import { PREVIEW_LINE, PREVIEW_VOICES } from "@/lib/previewSamples";
import { useSettings, useSettingsReady } from "@/lib/settings";
import { useTwitchSignIn } from "@/lib/useTwitchSignIn";
import styles from "./home.module.css";

/**
 * Screen 2a — the public landing page.
 *
 * This route used to be nothing but the entry router (login → setup → dashboard). The
 * handoff's navigation rule now reads "home page → login → …", so the redirect is gone and
 * `/` is a real page: it is the URL a streamer is sent in chat, and it has to explain the app
 * to somebody who has never heard of it.
 *
 * What survives of the old router is the *destination*: a visitor who has already signed in
 * gets a one-click way back in rather than being asked to sign in again. Bouncing them
 * straight to /dashboard instead was the other option and was rejected — it would make the
 * landing page unreachable for exactly the person most likely to want to link it.
 */

/** Backstop for an element that never fires `ended` — a stalled fetch, a decode that dies. */
const WATCHDOG_MS = 20000;
/** The gap between the coin chime and the voice, so the two do not talk over each other. */
const CHIME_LEAD_MS = 420;

export default function Home() {
  const router = useRouter();
  const ready = useSettingsReady();
  const settings = useSettings();
  const preview = useCheerPreview();

  // Pre-hydration this is false for everyone, which is the right default: the server render
  // is the one a first-time visitor sees, and a first-time visitor signs in.
  const signedIn = ready && Boolean(settings.auth.token);
  const destination = settings.setupComplete ? "/dashboard" : "/setup";

  const signIn = useTwitchSignIn(() => router.push(destination));

  const cta = signedIn
    ? { label: settings.setupComplete ? "Open dashboard" : "Finish setup", onClick: () => router.push(destination) }
    : { label: signIn.busy ? "Waiting for Twitch…" : "Sign in with Twitch", onClick: signIn.signIn };

  return (
    <main className={styles.page}>
      <div className={styles.shell}>
        <div className={styles.circle} aria-hidden />

        {/* a. brand row — deliberately not a nav; the design has no menu links. */}
        <header className={styles.brandRow}>
          <Coin size={34} />
          <span className={styles.wordmark}>Moneybot TTS</span>
          <div className={styles.brandActions}>
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
            <button
              type="button"
              className={`btn btn-twitch ${styles.brandCta}`}
              onClick={cta.onClick}
              disabled={signIn.busy}
            >
              {cta.label}
            </button>
          </div>
        </header>

        {/* b. hero */}
        <section className={styles.hero}>
          <div className={styles.heroCopy}>
            <span className="tag tag-accent-2">For Twitch streamers</span>
            <h1 className={styles.heroTitle}>
              Chat pays,
              <br />
              Wormo says.
            </h1>
            <p className={styles.heroBody}>
              Moneybot reads your Twitch chat out loud. Pick what earns a voice: every message,
              cheers over a threshold, or a channel-point redeem. Then messages queue up, get
              spoken on stream, and animate an avatar you drop straight into OBS.
            </p>

            <div className={styles.heroActions}>
              <button
                type="button"
                className={`btn btn-twitch ${styles.heroCta}`}
                onClick={cta.onClick}
                disabled={signIn.busy}
              >
                <TwitchGlyph size={18} />
                {cta.label}
              </button>
              <span className={styles.heroReassure}>
                Your Twitch login stays in your own browser. No token ever reaches our server.
              </span>
            </div>
            {signIn.error && <p className={`error-line ${styles.heroError}`}>{signIn.error}</p>}

            <div className={styles.steps}>
              <div className={styles.step}>
                <div className={styles.stepIcon}>
                  <MessageSquare size={16} strokeWidth={2.75} />
                </div>
                <div className={styles.stepTitle}>1 · Choose the triggers</div>
                <div className={styles.stepBody}>
                  All chat, cheers above your minimum, or one channel-point reward.
                </div>
              </div>
              <div className={`${styles.step} ${styles.stepGold}`}>
                <div className={`${styles.stepIcon} ${styles.stepIconGold}`}>
                  {/* The tinted disc *is* the coin here, so this is the bare glyph rather
                      than a nested <Coin>, which would draw a second gradient circle. */}
                  <span className={styles.stepDollar}>$</span>
                </div>
                <div className={styles.stepTitle}>2 · Moneybot queues it</div>
                <div className={styles.stepBody}>
                  Skip, clear or mute from one dashboard. Big cheers go first.
                </div>
              </div>
              <div className={`${styles.step} ${styles.stepPurple}`}>
                <div className={`${styles.stepIcon} ${styles.stepIconPurple}`}>
                  <Star size={16} strokeWidth={2.75} />
                </div>
                <div className={styles.stepTitle}>3 · Your avatar talks</div>
                <div className={styles.stepBody}>
                  Add a browser source in OBS and it lip-syncs to every message.
                </div>
              </div>
            </div>
          </div>

          <div className={styles.heroSide}>
            {/* Chat demo — static sample content, and the one live control on the page. */}
            <div className={styles.demo}>
              <div className={styles.demoHead}>
                <span className={styles.demoDot} />
                <span className={styles.demoTitle}>Stream chat</span>
                <span className={styles.demoViewers}>312 viewers</span>
                <span className={styles.demoLive}>Live demo</span>
              </div>

              <div className={styles.demoLines}>
                <div>
                  <span className={styles.nameA}>quietstorm</span>
                  <span className={styles.chatBody}>: chat behave, the robot is listening</span>
                </div>
                <div>
                  <span className={styles.nameB}>mossy</span>
                  <span className={styles.chatBody}>: is the worm new? it blinks now??</span>
                </div>

                <div className={`${styles.event} ${styles.eventCheer}`}>
                  <span className={`${styles.eventBadge} ${styles.eventBadgeCheer}`}>50</span>
                  <div className={styles.eventText}>
                    <div className={styles.eyebrowCheer}>cheered 50 bits · will be read aloud</div>
                    <div>
                      <span className={styles.cheerName}>coin_gremlin</span>
                      <span className={styles.cheerBody}>
                        : Please tell chat what happened to the sandwich
                      </span>
                    </div>
                  </div>
                </div>

                <div>
                  <span className={styles.nameC}>grasstoucher</span>
                  <span className={styles.chatBody}>: pay the worm, he knows things</span>
                </div>

                <div className={`${styles.event} ${styles.eventRedeem}`}>
                  <span className={`${styles.eventBadge} ${styles.eventBadgeRedeem}`}>
                    <Star size={14} strokeWidth={2.75} />
                  </span>
                  <div className={styles.eventText}>
                    <div className={styles.eyebrowRedeem}>redeemed Make Moneybot Speak</div>
                    <div>
                      <span className={styles.redeemName}>lurkasaurus</span>
                      <span className={styles.redeemBody}>: say hi to my cat Miso</span>
                    </div>
                  </div>
                </div>
              </div>

              <div className={styles.demoFoot}>
                <button
                  type="button"
                  className={`btn btn-primary ${styles.playBtn}`}
                  onClick={preview.toggle}
                  title={preview.playing ? undefined : `“${PREVIEW_LINE}”`}
                >
                  {preview.playing ? (
                    <Square size={13} strokeWidth={2.75} fill="currentColor" />
                  ) : (
                    <Play size={13} strokeWidth={2.75} fill="currentColor" />
                  )}
                  {preview.playing ? "Stop preview" : "Play preview"}
                </button>
                <div className={styles.demoCaption}>
                  Hear the 50-bit cheer read aloud, the way your viewers will.
                </div>
              </div>
            </div>

            {/* Avatar card. Wormo is the shipped default art, not a placeholder. */}
            <div className={styles.avatarCard}>
              <div className={styles.avatarStage}>
                {preview.playing && <span className={styles.ring} aria-hidden />}
                {preview.playing ? (
                  <div className={styles.avatarTalk}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      className={`${styles.avatarImg} ${styles.avatarFrame} ${styles.frameClosed}`}
                      src={withBasePath("/avatar-idle.png")}
                      alt=""
                    />
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      className={`${styles.avatarImg} ${styles.avatarFrame} ${styles.frameOpen}`}
                      src={withBasePath("/avatar-talk.png")}
                      alt="Wormo, talking"
                    />
                  </div>
                ) : (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    className={styles.avatarImg}
                    src={withBasePath("/avatar-idle.png")}
                    alt="Wormo, the default avatar"
                  />
                )}
              </div>

              <div className={styles.avatarCopy}>
                <div className={styles.eyebrow}>Avatar overlay</div>
                <div className={styles.avatarHeading}>
                  Bring your own art: idle frame, talking frames, done.
                </div>
                <div className={styles.avatarBody}>
                  Transparent PNGs at any size. Add as many talking frames as you want, set the
                  cycling speed frame by frame, swap the whole set between streams, and preview it
                  all before it goes live.
                </div>
                <div className={styles.avatarTags}>
                  <span className="tag tag-accent">Unlimited frames</span>
                  <span className="tag tag-accent">Adjustable speed</span>
                  <span className="tag tag-neutral">PNG or GIF</span>
                  <span className="tag tag-neutral">OBS browser source</span>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* c. audience strip */}
        <section className={styles.audience}>
          <div className={styles.audienceCard}>
            <div className={styles.audienceEyebrow}>You are in chat</div>
            <div className={styles.audienceQuestion}>
              Has your favourite small streamer not read a message in ten minutes?
            </div>
            <div className={styles.audienceAnswer}>
              Tell them about this app. Free, five minutes to set up, and they never miss you
              again.
            </div>
          </div>
          <div className={`${styles.audienceCard} ${styles.audienceCardPurple}`}>
            <div className={`${styles.audienceEyebrow} ${styles.audienceEyebrowPurple}`}>
              You are the streamer
            </div>
            <div className={styles.audienceQuestion}>
              Does chat riot the second you stop looking at it?
            </div>
            <div className={styles.audienceAnswer}>
              This app is for you. Keep playing, Moneybot keeps reading, and nobody feels ignored.
            </div>
          </div>
        </section>

        {/* d. about the name */}
        <section className={styles.nameBand}>
          <div>
            <div className={styles.eyebrow}>About the name</div>
            <h3 className={styles.nameHeading}>No, it does not want your money.</h3>
            <p className={styles.namePara}>
              I am <strong>Monatry</strong> on Twitch, which comes from <em>monetary</em>, as in
              &quot;relating to money&quot;. So my bot became Moneybot. That is the whole story.
            </p>
            <p className={styles.namePara}>
              It can stay free because your device does all the work. The voices, the queue and the
              avatar all run in your own browser, so there are no servers to pay for, no cut of your
              bits, and no paid tier waiting behind a door.
            </p>
          </div>
          <div className={styles.claims}>
            <div className={styles.claim}>
              <span className={`${styles.claimBadge} ${styles.claimBadgeGold}`}>$0</span>
              <div>
                <div className={styles.claimTitle}>Free forever</div>
                <div className={styles.claimBody}>Every feature, no tiers, no trial clock.</div>
              </div>
            </div>
            <div className={styles.claim}>
              <span className={`${styles.claimBadge} ${styles.claimBadgePurple}`}>
                <Check size={18} strokeWidth={2.75} />
              </span>
              <div>
                <div className={styles.claimTitle}>Your bits stay yours</div>
                <div className={styles.claimBody}>
                  Cheers are only a trigger. Moneybot never touches revenue.
                </div>
              </div>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}

/**
 * The "Play preview" button: a two-note coin chime, then the sample cheer in one of the
 * app's own Kokoro voices, with the avatar talking for exactly as long as the audio lasts.
 *
 * The clips are **pre-rendered** by `tools/build-samples.py` into `public/samples/`, one per
 * English voice. Synthesising in the page was the obvious alternative and is wrong on both
 * builds: the browser engine would pull 86 MB of weights before an unsigned-in visitor heard
 * anything, and the server engine would be pointing a public page at the Kokoro relay. A
 * static mp3 is one ~40 KB fetch, on click, and identical on both.
 *
 * The voice is re-rolled every press and never repeats back to back, so a second press
 * demonstrates the range rather than replaying the same read — which is the whole argument
 * for using the real engine here instead of the visitor's OS voice. Which one it landed on is
 * deliberately *not* shown: a label that appears only while playing reflows the card under
 * the button the visitor just pressed.
 */
function useCheerPreview() {
  const [playing, setPlaying] = useState(false);
  const timers = useRef<number[]>([]);
  const audioCtx = useRef<AudioContext | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const lastVoice = useRef<string | null>(null);

  const clearTimers = useCallback(() => {
    for (const id of timers.current) window.clearTimeout(id);
    timers.current = [];
  }, []);

  const stop = useCallback(() => {
    clearTimers();
    if (audio.current) {
      audio.current.pause();
      audio.current.src = "";
      audio.current = null;
    }
    setPlaying(false);
  }, [clearTimers]);

  // A page left mid-preview would otherwise keep talking over whatever comes next.
  useEffect(() => () => stop(), [stop]);

  const chime = useCallback(() => {
    const Ctor =
      window.AudioContext ??
      (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    const ctx = (audioCtx.current ??= new Ctor());
    void ctx.resume();
    [1318, 1760].forEach((hz, i) => {
      const at = ctx.currentTime + i * 0.16;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "triangle";
      osc.frequency.value = hz;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.18, at + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.3);
      osc.connect(gain).connect(ctx.destination);
      osc.start(at);
      osc.stop(at + 0.32);
    });
  }, []);

  const start = useCallback(() => {
    const pool = PREVIEW_VOICES.filter((v) => v !== lastVoice.current);
    const picked = pool[Math.floor(Math.random() * pool.length)];
    lastVoice.current = picked;

    setPlaying(true);
    chime();

    const el = new Audio(withBasePath(`/samples/${picked}.mp3`));
    el.preload = "auto";
    audio.current = el;
    el.addEventListener("ended", () => stop());
    el.addEventListener("error", () => stop());

    const playAfterChime = () =>
      timers.current.push(
        window.setTimeout(() => {
          if (audio.current !== el) return; // stopped, or a later press took over
          void el.play().catch(() => stop());
        }, CHIME_LEAD_MS),
      );

    /*
     * The chime leads by ~420 ms so the two do not overlap — but a `play()` that first
     * happens inside a timer has lost the user gesture, and iOS Safari refuses it. A *muted*
     * play-then-pause inside the click unlocks the element without making a sound, after
     * which the delayed play is allowed. If even that is refused, fall through and try the
     * real one anyway rather than deciding the button is dead.
     */
    el.muted = true;
    void el.play().then(
      () => {
        el.pause();
        el.currentTime = 0;
        el.muted = false;
        playAfterChime();
      },
      () => {
        el.muted = false;
        playAfterChime();
      },
    );

    timers.current.push(window.setTimeout(() => stop(), WATCHDOG_MS));
  }, [chime, stop]);

  const toggle = useCallback(() => {
    if (playing) stop();
    else start();
  }, [playing, start, stop]);

  return { playing, toggle };
}
