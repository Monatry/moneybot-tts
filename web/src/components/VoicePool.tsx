"use client";

/**
 * Which voices a chatter nobody has heard before may be rolled — `settings.randomVoices`.
 *
 * The one voice control a streamer gets, and deliberately the only one: a chatter's voice
 * still belongs to the chatter (lib/userVoices.ts), so this narrows what the *roll* draws
 * from and never reassigns anybody.
 *
 * The list is **baked in** (`lib/voiceCatalogue.ts`), not the engine's — this screen is where
 * voices get chosen and it has to render before anything has connected. Each chip plays the
 * voice guide's own sample for that voice, from `public/voice-samples/`: the guide is one
 * static page away and still linked, but "which of these is Fenrir" is a question you answer
 * while ticking boxes, not in another tab.
 *
 * The empty list is the default, not "nothing selected", and the two have to be told apart
 * on screen or the first visit looks like a pool that has been switched off. So an empty
 * list renders as the default pool, checked, with the caption saying so; the first click
 * writes that same set out explicitly and edits it from there.
 */

import { ExternalLink, Pause, Play } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { updateSettings, useSettings } from "@/lib/settings";
import { IS_BROWSER_ENGINE } from "@/lib/ttsEngine";
import {
  sampleCaption,
  VOICE_GROUPS,
  VOICE_GUIDE_URL,
  VOICE_IDS,
  voiceSampleUrl,
  type CatalogueVoice,
} from "@/lib/voiceCatalogue";
import { isDefaultEligible, randomPool } from "@/lib/userVoices";
import styles from "./VoicePool.module.css";

export function VoicePool() {
  const settings = useSettings();
  const chosen = settings.randomVoices;
  const sample = useSamplePlayer();

  // Empty means the default, so "has the streamer picked?" is the question every branch
  // below asks — never `chosen.length` inline, which reads as "is the pool empty".
  const picked = chosen.length > 0;
  const pickedIds = useMemo(() => new Set(chosen), [chosen]);

  const isChecked = (id: string) =>
    picked ? pickedIds.has(id.toLowerCase()) : isDefaultEligible(id);

  /**
   * What a roll would actually draw from, which is not always what is ticked: `randomPool`
   * widens rather than ever handing back nothing, so a pool whose every voice this build
   * lacks silently falls back to English. Showing the real number is the only way that is
   * visible before it happens on stream.
   */
  const effective = useMemo(() => randomPool(VOICE_IDS, chosen), [chosen]);
  const checkedCount = VOICE_IDS.filter(isChecked).length;

  /**
   * Ids the streamer picked that this build cannot speak — the 54-voice server build and the
   * 28-voice browser one share a settings blob (see CLAUDE.md). They are kept, not pruned:
   * the pool is the streamer's, and trimming it here would quietly delete their non-English
   * picks the first time they opened the other build.
   */
  const offList = useMemo(() => chosen.filter((id) => !VOICE_IDS.includes(id)), [chosen]);

  /** The explicit list to edit from — the picks, or the default written out. */
  function baseline(): string[] {
    return picked ? [...chosen] : VOICE_IDS.filter(isDefaultEligible);
  }

  function setPool(ids: string[]) {
    // `normalize` lower-cases, de-duplicates and sorts, so nothing here has to.
    updateSettings((prev) => ({ ...prev, randomVoices: ids }));
  }

  function toggle(id: string, on: boolean) {
    const key = id.toLowerCase();
    const base = baseline();
    setPool(on ? [...base, key] : base.filter((v) => v !== key));
  }

  function setGroup(ids: string[], on: boolean) {
    const keys = new Set(ids.map((v) => v.toLowerCase()));
    const base = baseline();
    setPool(on ? [...base, ...keys] : base.filter((v) => !keys.has(v)));
  }

  return (
    <div className={styles.wrap}>
      <Header />

      <div className={styles.actions}>
        <span className={styles.count}>
          {picked ? `${checkedCount} of ${VOICE_IDS.length} voices` : `Default: English only`}
        </span>
        <span className={styles.spacer} />
        <button
          type="button"
          className={styles.linkBtn}
          // The off-list picks ride along: this build cannot show them, and "select all" is
          // not the streamer asking for their other build's pool to be thrown away.
          onClick={() => setPool([...VOICE_IDS, ...offList])}
        >
          Select all
        </button>
        <button
          type="button"
          className={styles.linkBtn}
          onClick={() => setPool([])}
          disabled={!picked}
        >
          Reset to default
        </button>
      </div>

      <p className={styles.caption}>
        {picked
          ? "Only these are rolled for a chatter nobody has heard before. Everyone already speaking keeps the voice they have."
          : "No pool set, so a new chatter is rolled any English voice — which is what the ticks below show. Change one and the pool becomes yours to edit."}
      </p>

      {picked && checkedCount === 0 && (
        <p className={styles.warn}>
          None of the picked voices exist on this build, so a roll falls back to the{" "}
          {effective.length} English ones until at least one of them does.
        </p>
      )}

      {offList.length > 0 && (
        <p className={styles.caption}>
          {offList.length} picked {offList.length === 1 ? "voice is" : "voices are"} not in this
          build&rsquo;s list. They are kept, and used wherever they do exist.
        </p>
      )}

      <div className={styles.groups}>
        {VOICE_GROUPS.map((group) => {
          const ids = group.voices.map((v) => v.id);
          const allOn = ids.every(isChecked);
          return (
            <section
              key={group.code || group.country}
              className={styles.group}
              role="group"
              aria-label={`${group.language} voices`}
            >
              <div className={styles.groupHead}>
                <span className={styles.groupName}>
                  <span aria-hidden>{group.flag}</span> {group.language}
                </span>
                <button
                  type="button"
                  className={styles.linkBtn}
                  onClick={() => setGroup(ids, !allOn)}
                >
                  {allOn ? "None" : "All"}
                </button>
              </div>
              <div className={styles.chips}>
                {group.voices.map((voice) => (
                  <Chip
                    key={voice.id}
                    voice={voice}
                    checked={isChecked(voice.id)}
                    onToggle={(on) => toggle(voice.id, on)}
                    playing={sample.playing === voice.id}
                    onPlay={() => sample.toggle(voice.id)}
                  />
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

/**
 * One voice: a checkbox chip with the sample button beside it.
 *
 * The button is a sibling of the label rather than inside it — a `<button>` within a
 * `<label>` toggles the checkbox on its way through, so hearing a voice would tick it.
 */
function Chip({
  voice,
  checked,
  onToggle,
  playing,
  onPlay,
}: {
  voice: CatalogueVoice;
  checked: boolean;
  onToggle: (on: boolean) => void;
  playing: boolean;
  onPlay: () => void;
}) {
  return (
    <div className={styles.chip} data-on={checked || undefined}>
      <label className={styles.pick} title={voice.id}>
        <input
          type="checkbox"
          className={styles.box}
          checked={checked}
          onChange={(e) => onToggle(e.target.checked)}
        />
        <span className={styles.chipName}>{voice.name}</span>
        {voice.gender && (
          <span className={styles.chipMeta} aria-hidden>
            {voice.gender[0]}
          </span>
        )}
        <span className={styles.srOnly}>
          {voice.gender ? `${voice.gender}, ` : ""}
          {voice.id}
        </span>
      </label>
      <button
        type="button"
        className={styles.play}
        data-playing={playing || undefined}
        onClick={onPlay}
        // The line is on the button, not the chip: it is what pressing this plays, and for
        // the non-English voices it is the only place the translation can go.
        title={sampleCaption(voice)}
        aria-label={`${playing ? "Stop" : "Hear"} ${voice.name}`}
      >
        {playing ? <Pause size={12} strokeWidth={3} /> : <Play size={12} strokeWidth={3} />}
      </button>
    </div>
  );
}

/**
 * Plays one sample at a time.
 *
 * One element, reused: pressing a second chip while the first is still speaking is the
 * normal way to compare two voices, and two overlapping reads tell you nothing. `play()`
 * happens inside the click, so there is nothing to unlock — unlike the landing page's
 * preview, which has a chime in front of it and loses the gesture to a timer.
 */
function useSamplePlayer() {
  const [playing, setPlaying] = useState<string | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);

  const stop = useCallback(() => {
    if (audio.current) {
      audio.current.pause();
      audio.current.src = "";
      audio.current = null;
    }
    setPlaying(null);
  }, []);

  // Leaving the screen mid-sample would otherwise keep talking over the next one.
  useEffect(() => () => stop(), [stop]);

  const toggle = useCallback(
    (id: string) => {
      const same = playing === id;
      stop();
      if (same) return;
      const el = new Audio(voiceSampleUrl(id));
      audio.current = el;
      setPlaying(id);
      const done = () => {
        if (audio.current === el) stop();
      };
      el.addEventListener("ended", done);
      // A missing mp3 must clear the button rather than leave it stuck on "playing".
      el.addEventListener("error", done);
      void el.play().catch(done);
    },
    [playing, stop],
  );

  return { playing, toggle };
}

function Header() {
  return (
    <div className={styles.head}>
      <div>
        <h4 className={styles.title}>Random voice pool</h4>
        <p className={styles.lede}>
          What a chatter you have never heard before gets rolled. Press a voice to hear it; a
          chatter can still ask for any of them by name.
        </p>
      </div>
      {/* Unset renders nothing at all: there is no guide to guess at, and the picker works
          perfectly well without one. See VOICE_GUIDE_URL. */}
      {VOICE_GUIDE_URL !== "" && (
        <a
          className={styles.guide}
          href={VOICE_GUIDE_URL}
          target="_blank"
          rel="noreferrer noopener"
        >
          Voice guide
          <ExternalLink size={13} strokeWidth={2.5} aria-hidden />
        </a>
      )}
    </div>
  );
}

/**
 * The one thing the guide over-promises on a browser-engine build, said once and next to
 * the link rather than on every chip: kokoro-js maps the English voices only, while the
 * guide lists all 54. Folds away entirely on a server build.
 */
export function VoicePoolEngineNote() {
  if (!IS_BROWSER_ENGINE) return null;
  return (
    <p className={styles.caption}>
      This build synthesises in your own browser, which carries the English voices only. The
      guide lists every voice the OBS overlay can use.
    </p>
  );
}
