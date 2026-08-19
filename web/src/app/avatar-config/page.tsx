"use client";

import { Anchor, ArrowLeft, ArrowRight, HelpCircle, Move, Plus, X } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppNav } from "@/components/AppNav";
import { AvatarStage } from "@/components/AvatarStage";
import { Coin } from "@/components/Coin";
import { ObsGuide } from "@/components/ObsGuide";
import { OverlayUrlRow } from "@/components/OverlayUrlRow";
import { MiniWaveform } from "@/components/Waveform";
import { Slider } from "@/components/Slider";
import { Toggle } from "@/components/Toggle";
import {
  ImageRejected,
  loadAvatar,
  postAvatarMessage,
  prepareImage,
  pushAvatarImagesToObs,
  resetAvatar,
  saveFrames,
  saveIdle,
  type StoredImage,
} from "@/lib/avatarStore";
import { getBot, useBot } from "@/lib/bot";
import { DEFAULT_OBS_URL, type ObsBridgeStatus } from "@/lib/obsBridge";
import { pushAvatarToObs, useObsBridge } from "@/lib/useObsBridge";
import {
  BOB_ANGLE_RANGE,
  BOB_ATTACK_RANGE,
  BOB_DECAY_RANGE,
  BOB_MIN_ANGLE_RANGE,
  BOB_SPEED_RANGE,
  CAPTION_SIZE_RANGE,
  CROSSFADE_MS_RANGE,
  DEFAULT_AVATAR,
  DEFAULT_AVATAR_BACKGROUND,
  TRANSPARENT_BACKGROUND,
  normalizeBackground,
  settingsStore,
  updateSettings,
  useSettings,
  type AvatarSettings,
} from "@/lib/settings";
import { useObjectUrl, useObjectUrls } from "@/lib/useObjectUrls";
import styles from "./avatar.module.css";

const TEST_LINE = "Moneybot is ready to read your chat.";

/** The three keying colours OBS filters name, plus black for a scene that is composited. */
const BACKGROUND_PRESETS = [
  { hex: DEFAULT_AVATAR_BACKGROUND, label: "Green screen" },
  { hex: "#0000FF", label: "Blue screen" },
  { hex: "#FF00FF", label: "Magenta" },
  { hex: "#000000", label: "Black" },
];

/** Screen 1e — upload the idle image and talking frames, set the animation speed, preview. */
export default function AvatarConfigPage() {
  const settings = useSettings();
  const bot = useBot();
  const obsStatus = useObsBridge();

  const [idle, setIdle] = useState<StoredImage | null>(null);
  const [frames, setFrames] = useState<StoredImage[]>([]);
  const [fps, setFps] = useState(settings.avatar.fps);
  // The colour and the transparent choice are held apart so that ticking "transparent" and
  // then unticking it comes back to the colour that was picked, not to the default.
  const [colorHex, setColorHex] = useState(
    settings.avatar.background === TRANSPARENT_BACKGROUND
      ? DEFAULT_AVATAR_BACKGROUND
      : settings.avatar.background,
  );
  const [transparent, setTransparent] = useState(
    settings.avatar.background === TRANSPARENT_BACKGROUND,
  );
  // The three opt-in effects, each held as a draft like everything else on this screen —
  // nothing reaches the overlay until Save.
  const [crossfade, setCrossfade] = useState(settings.avatar.crossfade);
  const [caption, setCaption] = useState(settings.avatar.caption);
  const [bob, setBob] = useState(settings.avatar.bob);
  // What is in the text box while it is being typed in — "#00F" is not yet a colour, and
  // rejecting it keystroke by keystroke would make the field impossible to edit.
  const [hexDraft, setHexDraft] = useState(colorHex);
  const [reordering, setReordering] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  // The OBS connection fields are the one thing on this screen that is *not* a draft waiting
  // for Save — they configure a live socket, and a URL you cannot see the result of typing
  // is a URL you cannot debug. They are held locally only so that the socket reconnects when
  // the field is finished with rather than on every keystroke.
  const [obsUrlDraft, setObsUrlDraft] = useState(settings.obs.url);
  const [obsPasswordDraft, setObsPasswordDraft] = useState(settings.obs.password);
  const [obsPushed, setObsPushed] = useState(false);
  const [obsSending, setObsSending] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);

  // Everything edited here is held in component state and only written to IndexedDB by
  // "Save avatar" — this is the one screen the handoff gives an explicit Save, so a dropped
  // file that turns out to be wrong can be abandoned by leaving.
  useEffect(() => {
    void loadAvatar().then(({ idle, frames }) => {
      setIdle(idle);
      setFrames(frames);
    });
  }, []);

  useEffect(() => setObsUrlDraft(settings.obs.url), [settings.obs.url]);
  useEffect(() => setObsPasswordDraft(settings.obs.password), [settings.obs.password]);

  useEffect(() => setFps(settings.avatar.fps), [settings.avatar.fps]);
  useEffect(() => setCrossfade(settings.avatar.crossfade), [settings.avatar.crossfade]);
  useEffect(() => setCaption(settings.avatar.caption), [settings.avatar.caption]);
  useEffect(() => setBob(settings.avatar.bob), [settings.avatar.bob]);

  useEffect(() => {
    const stored = settings.avatar.background;
    setTransparent(stored === TRANSPARENT_BACKGROUND);
    if (stored !== TRANSPARENT_BACKGROUND) {
      setColorHex(stored);
      setHexDraft(stored);
    }
  }, [settings.avatar.background]);

  const background = transparent ? TRANSPARENT_BACKGROUND : colorHex;

  /** Exactly what Save would write — so the preview is the overlay, not an impression of it. */
  const draft: AvatarSettings = {
    fps,
    hasIdle: idle !== null,
    frameCount: frames.length,
    background,
    crossfade,
    caption,
    bob,
  };

  function pickColor(hex: string) {
    const next = normalizeBackground(hex);
    setColorHex(next);
    setHexDraft(next);
    setTransparent(false);
    setSaved(false);
  }

  const accept = useCallback(async (files: FileList | File[], into: "idle" | "frames") => {
    setError(null);
    const prepared: StoredImage[] = [];
    for (const file of Array.from(files)) {
      try {
        prepared.push(await prepareImage(file));
      } catch (err) {
        setError(err instanceof ImageRejected ? err.message : `${file.name} could not be read.`);
      }
    }
    if (prepared.length === 0) return;
    setSaved(false);
    if (into === "idle") setIdle(prepared[0]);
    else setFrames((prev) => [...prev, ...prepared]);
  }, []);

  async function save() {
    await saveIdle(idle);
    await saveFrames(frames);
    updateSettings((prev) => ({ ...prev, avatar: draft }));
    // The overlay window has its own cached copy of the settings — a localStorage write in
    // this window does not reach it. Push the stored (normalized) values explicitly; the
    // images it re-reads from IndexedDB off the config-changed ping the saves above send.
    postAvatarMessage({ type: "settings", avatar: settingsStore.get().avatar });
    // An overlay in OBS cannot read the IndexedDB written above — it is a different browser.
    // The settings message reached it over the bridge with everything else; the images have
    // to be carried there explicitly.
    void pushAvatarImagesToObs();
    setSaved(true);
  }

  async function reset() {
    await resetAvatar();
    setIdle(null);
    setFrames([]);
    setFps(DEFAULT_AVATAR.fps);
    setColorHex(DEFAULT_AVATAR_BACKGROUND);
    setHexDraft(DEFAULT_AVATAR_BACKGROUND);
    setTransparent(false);
    setCrossfade(DEFAULT_AVATAR.crossfade);
    setCaption(DEFAULT_AVATAR.caption);
    setBob(DEFAULT_AVATAR.bob);
    updateSettings((prev) => ({ ...prev, avatar: DEFAULT_AVATAR }));
    postAvatarMessage({ type: "settings", avatar: settingsStore.get().avatar });
    // Clears the images out of OBS too — the reset sends an empty set, which is a real set.
    void pushAvatarImagesToObs();
    setSaved(false);
  }

  /** Commit the connection fields. Called on blur, so a socket is not re-dialled per keystroke. */
  function commitObs(next: Partial<{ enabled: boolean; url: string; password: string }>) {
    updateSettings((prev) => ({ ...prev, obs: { ...prev.obs, ...next } }));
    setObsPushed(false);
  }

  async function sendToObs() {
    // A push runs for seconds. Without this the button invites a second click on top of the
    // first, and although the receiver now discards the abandoned stream, the visible result
    // is still an avatar that takes two goes to appear for no reason the streamer can see.
    setObsSending(true);
    try {
      setObsPushed(await pushAvatarToObs());
    } finally {
      setObsSending(false);
    }
  }

  function testSpeak() {
    const runtime = getBot();
    void runtime.player.unlock().then(() => {
      void runtime.ensureVoices().then(() => runtime.enqueueTest(TEST_LINE));
    });
  }

  const frameHoldMs = Math.round(1000 / fps);
  // What the attack, decay and speed range actually add up to, at both ends of the roll.
  const bobFast = formatSeconds((bob.attackMs + bob.decayMs) / bob.speedMax);
  const bobSlow = formatSeconds((bob.attackMs + bob.decayMs) / bob.speedMin);
  // Flip mirrors both ends of the swing, so the readouts show what will actually be drawn.
  const sign = bob.flip ? -1 : 1;
  const nothingToDraw = !idle && frames.length === 0;
  // The real line while one is being read, so "Test speak" shows the caption at its true
  // length; a sample otherwise, so the caption is there to be dragged.
  const captionPreview = bot.nowPlaying?.request.text ?? TEST_LINE;

  return (
    <div className={styles.screen}>
      <AppNav compact right={<span className={styles.navNote}>Avatar configuration</span>}>
        <Link href="/dashboard" className={styles.backLink}>
          <ArrowLeft size={14} strokeWidth={2.75} /> Back to dashboard
        </Link>
      </AppNav>

      <div className={styles.body}>
        <main className={styles.form}>
          <div>
            <h2 style={{ margin: "0 0 4px" }}>Avatar</h2>
            <p className={styles.lede}>
              One idle image, one or more talking frames. Moneybot cycles the talking frames
              while a message is read.
            </p>
          </div>

          {error && <p className="error-line">{error}</p>}

          {/* ── OBS browser source ─────────────────────────────────────
              First, ahead of the images and the effects it carries, because it is the step
              that decides whether any of them survive a stream: everything below is tuned
              against the preview, and a streamer who never scrolls this far runs the overlay
              as a browser window, which the browser stops drawing the moment it is covered. */}
          <section className={styles.section}>
            <div className={styles.sectionHead}>
              <h4 style={{ margin: 0 }}>Send to OBS</h4>
              <span className={styles.sectionNote}>for a browser source, instead of a window</span>
              <button
                type="button"
                className="btn btn-ghost"
                style={{ marginLeft: "auto" }}
                onClick={() => setGuideOpen(true)}
              >
                <HelpCircle size={14} strokeWidth={2.75} /> How do I set this up?
              </button>
            </div>

            <div className={styles.bgToggleRow}>
              <Toggle
                label="Connect to OBS"
                size="sm"
                checked={settings.obs.enabled}
                onChange={(next) => commitObs({ enabled: next })}
              />
              <span className={styles.bgToggleText}>
                Push the avatar straight into OBS over its WebSocket
              </span>
            </div>

            {settings.obs.enabled && (
              <>
                <div className={styles.obsFields}>
                  <label className={styles.obsField}>
                    <span className={styles.obsLabel}>WebSocket URL</span>
                    <input
                      className={styles.obsInput}
                      value={obsUrlDraft}
                      placeholder={DEFAULT_OBS_URL}
                      spellCheck={false}
                      onChange={(e) => setObsUrlDraft(e.target.value)}
                      onBlur={() => commitObs({ url: obsUrlDraft })}
                      onKeyDown={(e) => e.key === "Enter" && commitObs({ url: obsUrlDraft })}
                    />
                  </label>
                  <label className={styles.obsField}>
                    <span className={styles.obsLabel}>Password</span>
                    <input
                      className={styles.obsInput}
                      type="password"
                      value={obsPasswordDraft}
                      placeholder="from OBS ▸ Tools ▸ WebSocket Server Settings"
                      onChange={(e) => setObsPasswordDraft(e.target.value)}
                      onBlur={() => commitObs({ password: obsPasswordDraft })}
                      onKeyDown={(e) =>
                        e.key === "Enter" && commitObs({ password: obsPasswordDraft })
                      }
                    />
                  </label>
                </div>

                <div className={styles.obsStatusRow}>
                  <span className={styles[obsDotClass(obsStatus.state)]} aria-hidden />
                  <span className={styles.obsStatusText}>{obsStatusText(obsStatus)}</span>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    style={{ marginLeft: "auto" }}
                    onClick={() => void sendToObs()}
                    disabled={obsStatus.state !== "connected" || obsSending}
                  >
                    {obsSending ? "Sending…" : obsPushed ? "Sent" : "Send avatar now"}
                  </button>
                </div>
              </>
            )}

            {/* The URL a browser source is pointed at, copyable, in the panel the streamer is
                already in — the same component the guide's step 4 uses, so neither can show a
                URL the other does not. */}
            <OverlayUrlRow />

            <div className={styles.speedHint}>
              {settings.obs.enabled
                ? "Add a Browser source in OBS pointing at this URL. A source added later needs Send avatar now — the bridge only carries the images one way."
                : "A browser source in OBS is its own browser: it cannot see the images or the settings stored here, which is why they have to be sent. Switch this on and the avatar goes to OBS directly, with none of the throttling a hidden or covered browser window is subject to."}
            </div>
          </section>

          {/* ── idle image ─────────────────────────────────────────── */}
          <section className={styles.section}>
            <div className={styles.sectionHead}>
              <h4 style={{ margin: 0 }}>Idle image</h4>
              <span className={styles.sectionNote}>shown when the queue is empty</span>
            </div>
            <div className={styles.idleRow}>
              <div className={styles.idleTile}>
                {idle ? (
                  <>
                    <ImagePreview image={idle} className={styles.idleImg} />
                    <button
                      type="button"
                      className={styles.frameDelete}
                      aria-label="Remove the idle image"
                      title="Remove the idle image"
                      onClick={() => {
                        setIdle(null);
                        setSaved(false);
                      }}
                    >
                      <X size={11} strokeWidth={3} />
                    </button>
                  </>
                ) : (
                  <Coin size={66} shadow={0} />
                )}
                <span className={styles.idleCaption}>
                  {idle ? `${idle.name} · ${idle.width}×${idle.height}` : "no image yet"}
                </span>
              </div>
              <Dropzone
                title="Drop a new image here"
                hint="PNG or GIF with transparency, up to 4 MB"
                buttonLabel="Choose file"
                onFiles={(files) => void accept(files, "idle")}
              />
            </div>
            {nothingToDraw && (
              <p className="hint-line" style={{ marginTop: 0 }}>
                With no images at all the overlay draws nothing — an empty browser source, not
                a placeholder sitting in your scene.
              </p>
            )}
          </section>

          {/* ── talking frames ─────────────────────────────────────── */}
          <section className={styles.section}>
            <div className={styles.sectionHead}>
              <h4 style={{ margin: 0 }}>Talking frames</h4>
              <span className={styles.sectionNote}>
                {frames.length} frame{frames.length === 1 ? "" : "s"} · played in order
              </span>
              <button
                type="button"
                className="btn btn-ghost"
                style={{ marginLeft: "auto" }}
                onClick={() => setReordering((r) => !r)}
                disabled={frames.length < 2}
              >
                {reordering ? "Done" : "Reorder"}
              </button>
            </div>

            <div className={styles.frameGrid}>
              {frames.map((frame, i) => (
                <div key={`${frame.name}-${i}`} className={styles.frameTile}>
                  <ImagePreview image={frame} className={styles.frameImg} />
                  <span className={styles.frameIndex}>{String(i + 1).padStart(2, "0")}</span>
                  <button
                    type="button"
                    className={styles.frameDelete}
                    aria-label={`Delete frame ${i + 1}`}
                    onClick={() => {
                      setFrames((prev) => prev.filter((_, j) => j !== i));
                      setSaved(false);
                    }}
                  >
                    <X size={11} strokeWidth={3} />
                  </button>
                  {reordering && (
                    <div className={styles.frameMove}>
                      <button
                        type="button"
                        aria-label={`Move frame ${i + 1} earlier`}
                        disabled={i === 0}
                        onClick={() => setFrames((prev) => swap(prev, i, i - 1))}
                      >
                        <ArrowLeft size={12} strokeWidth={3} />
                      </button>
                      <button
                        type="button"
                        aria-label={`Move frame ${i + 1} later`}
                        disabled={i === frames.length - 1}
                        onClick={() => setFrames((prev) => swap(prev, i, i + 1))}
                      >
                        <ArrowRight size={12} strokeWidth={3} />
                      </button>
                    </div>
                  )}
                </div>
              ))}

              <AddFramesTile onFiles={(files) => void accept(files, "frames")} />
            </div>

            {frames.length === 0 && idle && (
              <p className="hint-line" style={{ marginTop: 0 }}>
                No talking frames, so the overlay will show the idle image the whole time. That
                is a valid static avatar, not a broken one.
              </p>
            )}
          </section>

          {/* ── speed ──────────────────────────────────────────────── */}
          <section className={styles.speedPanel}>
            <div className={styles.speedHead}>
              <span className={styles.speedLabel}>Talking animation speed</span>
              <span className={styles.speedValue}>{fps} fps</span>
            </div>
            <div className={styles.speedRow}>
              <span className={styles.speedEnd}>Slow</span>
              <Slider
                label="Talking animation speed"
                min={4}
                max={24}
                step={1}
                value={fps}
                ariaValueText={`${fps} frames per second`}
                onChange={(v) => {
                  setFps(v);
                  setSaved(false);
                }}
              />
              <span className={styles.speedEnd}>Fast</span>
            </div>
            <div className={styles.speedHint}>
              Each frame holds ~{frameHoldMs} ms. Below 6 fps the mouth reads as stuttering.
            </div>
          </section>

          {/* ── crossfade ──────────────────────────────────────────── */}
          <section className={styles.speedPanel}>
            <div className={styles.speedHead}>
              <span className={styles.speedLabel}>Crossfade</span>
              <div className={styles.headRight}>
                <span className={styles.speedValue}>
                  {crossfade.enabled ? `${crossfade.ms} ms` : "Off"}
                </span>
                <Toggle
                  label="Crossfade between idle and talking"
                  size="sm"
                  checked={crossfade.enabled}
                  onChange={(enabled) => {
                    setCrossfade((c) => ({ ...c, enabled }));
                    setSaved(false);
                  }}
                />
              </div>
            </div>
            <div className={styles.speedRow}>
              <span className={styles.speedEnd}>Quick</span>
              <Slider
                label="Crossfade length"
                min={CROSSFADE_MS_RANGE[0]}
                max={CROSSFADE_MS_RANGE[1]}
                step={10}
                value={crossfade.ms}
                disabled={!crossfade.enabled}
                ariaValueText={`${crossfade.ms} milliseconds`}
                onChange={(ms) => {
                  setCrossfade((c) => ({ ...c, ms }));
                  setSaved(false);
                }}
              />
              <span className={styles.speedEnd}>Slow</span>
            </div>
            <div className={styles.speedHint}>
              Fades between the idle image and the talking frames instead of cutting. Frame to
              frame inside the talking cycle still cuts — a fade longer than the {frameHoldMs} ms
              frame hold would smear the mouth into a blur.
            </div>
          </section>

          {/* ── caption ────────────────────────────────────────────── */}
          <section className={styles.speedPanel}>
            <div className={styles.speedHead}>
              <span className={styles.speedLabel}>Show the spoken line</span>
              <div className={styles.headRight}>
                <span className={styles.speedValue}>
                  {caption.enabled
                    ? `${Math.round(caption.x * 100)}% · ${Math.round(caption.y * 100)}%`
                    : "Off"}
                </span>
                <Toggle
                  label="Show the spoken line on the overlay"
                  size="sm"
                  checked={caption.enabled}
                  onChange={(enabled) => {
                    setCaption((c) => ({ ...c, enabled }));
                    setSaved(false);
                  }}
                />
              </div>
            </div>
            <div className={styles.speedRow}>
              <span className={styles.speedEnd}>Small</span>
              <Slider
                label="Caption size"
                min={CAPTION_SIZE_RANGE[0]}
                max={CAPTION_SIZE_RANGE[1]}
                step={0.5}
                value={caption.size}
                disabled={!caption.enabled}
                ariaValueText={`${caption.size} percent of the overlay height`}
                onChange={(size) => {
                  setCaption((c) => ({ ...c, size }));
                  setSaved(false);
                }}
              />
              <span className={styles.speedEnd}>Large</span>
            </div>
            <div className={styles.speedHint}>
              The line is drawn while it is being read, and disappears with the audio. Drag it in
              the Talking preview to place it; the size is a share of the overlay&apos;s height, so
              it scales with the browser source rather than being pinned to one resolution.
            </div>
          </section>

          {/* ── bob ────────────────────────────────────────────────── */}
          <section className={styles.speedPanel}>
            <div className={styles.speedHead}>
              <span className={styles.speedLabel}>Bobbing</span>
              <div className={styles.headRight}>
                <span className={styles.speedValue}>
                  {bob.enabled ? `${signed(sign * bob.minAngle)} → ${signed(sign * bob.angle)}` : "Off"}
                </span>
                <Toggle
                  label="Bobbing animation"
                  size="sm"
                  checked={bob.enabled}
                  onChange={(enabled) => {
                    setBob((b) => ({ ...b, enabled }));
                    setSaved(false);
                  }}
                />
              </div>
            </div>

            <TuneRow
              label="Angle"
              value={`${bob.angle}°`}
              slider={
                <Slider
                  label="Bobbing angle"
                  min={BOB_ANGLE_RANGE[0]}
                  max={BOB_ANGLE_RANGE[1]}
                  step={1}
                  value={bob.angle}
                  disabled={!bob.enabled}
                  ariaValueText={`${bob.angle} degrees`}
                  onChange={(angle) => {
                    setBob((b) => ({ ...b, angle }));
                    setSaved(false);
                  }}
                />
              }
            />
            <TuneRow
              label="Min angle"
              value={`${bob.minAngle}°`}
              slider={
                <Slider
                  label="Bobbing minimum angle"
                  min={BOB_MIN_ANGLE_RANGE[0]}
                  max={BOB_MIN_ANGLE_RANGE[1]}
                  step={1}
                  value={bob.minAngle}
                  disabled={!bob.enabled}
                  ariaValueText={`${bob.minAngle} degrees at rest`}
                  onChange={(minAngle) => {
                    setBob((b) => ({ ...b, minAngle }));
                    setSaved(false);
                  }}
                />
              }
            />
            <TuneRow
              label="Attack"
              value={`${bob.attackMs} ms`}
              slider={
                <Slider
                  label="Bobbing attack"
                  min={BOB_ATTACK_RANGE[0]}
                  max={BOB_ATTACK_RANGE[1]}
                  step={10}
                  value={bob.attackMs}
                  disabled={!bob.enabled}
                  ariaValueText={`${bob.attackMs} milliseconds out to the angle`}
                  onChange={(attackMs) => {
                    setBob((b) => ({ ...b, attackMs }));
                    setSaved(false);
                  }}
                />
              }
            />
            <TuneRow
              label="Decay"
              value={`${bob.decayMs} ms`}
              slider={
                <Slider
                  label="Bobbing decay"
                  min={BOB_DECAY_RANGE[0]}
                  max={BOB_DECAY_RANGE[1]}
                  step={10}
                  value={bob.decayMs}
                  disabled={!bob.enabled}
                  ariaValueText={`${bob.decayMs} milliseconds back to rest`}
                  onChange={(decayMs) => {
                    setBob((b) => ({ ...b, decayMs }));
                    setSaved(false);
                  }}
                />
              }
            />
            <TuneRow
              label="Slowest"
              value={`×${bob.speedMin.toFixed(2)}`}
              slider={
                <Slider
                  label="Slowest bob speed"
                  min={BOB_SPEED_RANGE[0]}
                  max={BOB_SPEED_RANGE[1]}
                  step={0.05}
                  value={bob.speedMin}
                  disabled={!bob.enabled}
                  ariaValueText={`${bob.speedMin.toFixed(2)} times speed`}
                  onChange={(speedMin) => {
                    // The two ends are separate sliders, so each pushes the other rather
                    // than letting the range cross over — a low above the high would roll
                    // speeds outside both of them.
                    setBob((b) => ({ ...b, speedMin, speedMax: Math.max(b.speedMax, speedMin) }));
                    setSaved(false);
                  }}
                />
              }
            />
            <TuneRow
              label="Fastest"
              value={`×${bob.speedMax.toFixed(2)}`}
              slider={
                <Slider
                  label="Fastest bob speed"
                  min={BOB_SPEED_RANGE[0]}
                  max={BOB_SPEED_RANGE[1]}
                  step={0.05}
                  value={bob.speedMax}
                  disabled={!bob.enabled}
                  ariaValueText={`${bob.speedMax.toFixed(2)} times speed`}
                  onChange={(speedMax) => {
                    setBob((b) => ({ ...b, speedMax, speedMin: Math.min(b.speedMin, speedMax) }));
                    setSaved(false);
                  }}
                />
              }
            />

            <div className={styles.bgToggleRow}>
              <Toggle
                label="Bob the other way"
                size="sm"
                checked={bob.flip}
                disabled={!bob.enabled}
                onChange={(flip) => {
                  setBob((b) => ({ ...b, flip }));
                  setSaved(false);
                }}
              />
              <span className={styles.bgToggleText}>
                Swings {signed(sign * bob.minAngle)} → {signed(sign * bob.angle)} — flip it to
                mirror the whole motion
              </span>
            </div>

            <div className={styles.speedHint}>
              A rotation around the anchor and nothing else, running while a line is read. It
              rests at the min angle and throws out to the angle: attack is the throw, decay the
              return. The speed is re-rolled on every bob between the two ends, so it never
              settles into a metronome — that works out to {bobFast} – {bobSlow} per bob. Drag
              the anchor in the Talking preview to set the point it turns around: at the feet it
              rocks like a bobblehead, at the top it swings like something hanging.
            </div>
          </section>

          {/* ── background ─────────────────────────────────────────── */}
          <section className={styles.bgPanel}>
            <div className={styles.speedHead}>
              <span className={styles.speedLabel}>Overlay background</span>
              <span className={styles.speedValue}>{transparent ? "Transparent" : colorHex}</span>
            </div>

            <div className={styles.bgRow}>
              <label className={styles.swatch} data-disabled={transparent || undefined}>
                <input
                  type="color"
                  value={colorHex}
                  disabled={transparent}
                  aria-label="Overlay background colour"
                  onChange={(e) => pickColor(e.target.value)}
                />
                <span className={styles.swatchFill} style={{ background: colorHex }} />
              </label>

              <input
                type="text"
                className={styles.hexInput}
                value={hexDraft}
                disabled={transparent}
                spellCheck={false}
                aria-label="Overlay background colour, hex"
                onChange={(e) => {
                  const raw = e.target.value;
                  setHexDraft(raw.startsWith("#") || raw === "" ? raw : `#${raw}`);
                  if (/^#[0-9a-f]{6}$/i.test(raw.trim())) pickColor(raw);
                }}
                // A half-typed value is never left showing a colour the overlay does not have.
                onBlur={() => setHexDraft(colorHex)}
              />

              <div className={styles.presets}>
                {BACKGROUND_PRESETS.map((preset) => (
                  <button
                    key={preset.hex}
                    type="button"
                    title={`${preset.label} · ${preset.hex}`}
                    aria-label={preset.label}
                    aria-pressed={!transparent && colorHex === preset.hex}
                    className={
                      !transparent && colorHex === preset.hex ? styles.presetOn : styles.preset
                    }
                    style={{ background: preset.hex }}
                    onClick={() => pickColor(preset.hex)}
                  />
                ))}
              </div>
            </div>

            <div className={styles.bgToggleRow}>
              <Toggle
                label="Transparent background"
                size="sm"
                checked={transparent}
                onChange={(next) => {
                  setTransparent(next);
                  setSaved(false);
                }}
              />
              <span className={styles.bgToggleText}>
                Transparent instead, no colour at all
              </span>
            </div>

            <div className={styles.speedHint}>
              {transparent
                ? "The overlay paints nothing behind the avatar. Works in an OBS browser source, which composites it directly; a window capture or a recording of the page will show whatever is behind it."
                : "Key this colour out in OBS with a chroma key filter. Green is the default because that is what the filter expects."}
            </div>
          </section>

          <div className={styles.actions}>
            <button type="button" className={`btn btn-primary ${styles.saveBtn}`} onClick={save}>
              {saved ? "Saved" : "Save avatar"}
            </button>
            <button type="button" className={`btn btn-secondary ${styles.resetBtn}`} onClick={reset}>
              Reset to default
            </button>
          </div>
        </main>

        {/* ── preview rail ─────────────────────────────────────────── */}
        <aside className={styles.previewRail}>
          <h4 style={{ margin: 0 }}>Preview</h4>

          <div className={styles.previewBlock}>
            <div className={styles.previewLabel}>
              <span className="tag tag-neutral">Idle</span>
              <span className={styles.previewNote}>queue empty</span>
            </div>
            {/* The shorthand clears the stage's checkerboard, which is only right while the
                background really is transparent. */}
            <div className={styles.stage} style={transparent ? undefined : { background }}>
              <PreviewStage idle={idle} frames={frames} speaking={false} avatar={draft} />
              {nothingToDraw && <span className={styles.stageEmpty}>nothing is drawn</span>}
            </div>
          </div>

          <div className={styles.previewBlock}>
            <div className={styles.previewLabel}>
              <span className="tag tag-accent">Talking</span>
              <span className={styles.previewNote}>frames cycling at {fps} fps</span>
            </div>
            {/* The handles live in a wrapper *over* the stage rather than inside it: the
                stage clips its own overflow so a bobbing avatar cannot escape the tile, and
                the bob anchor's default sits on the bottom edge, where it would be cut in
                half. The wrapper is the same box, so the fractions still map exactly. */}
            <div className={styles.stageWrap}>
              <div className={styles.stage} style={transparent ? undefined : { background }}>
                <PreviewStage
                  idle={idle}
                  frames={frames}
                  speaking
                  avatar={draft}
                  captionText={captionPreview}
                />
                <div className={styles.stageWave}>
                  <MiniWaveform />
                </div>
              </div>
              <DragLayer
                caption={caption.enabled ? caption : null}
                bob={bob.enabled ? bob : null}
                onCaption={(x, y) => {
                  setCaption((c) => ({ ...c, x, y }));
                  setSaved(false);
                }}
                onBob={(anchorX, anchorY) => {
                  setBob((b) => ({ ...b, anchorX, anchorY }));
                  setSaved(false);
                }}
              />
            </div>
          </div>

          <div className={styles.testCard}>
            <div className={styles.testText}>
              Play a test line to see the animation with real audio.
            </div>
            <button
              type="button"
              className={`btn btn-twitch ${styles.testBtn}`}
              onClick={testSpeak}
              disabled={!!bot.voicesError}
            >
              Test speak
            </button>
          </div>
          {bot.voicesError && (
            <p className="error-line">
              {bot.voicesError.message}
              <br />
              <span style={{ fontSize: 11.5, opacity: 0.75 }}>{bot.voicesError.detail}</span>
            </p>
          )}
        </aside>
      </div>

      <ObsGuide open={guideOpen} onClose={() => setGuideOpen(false)} />
    </div>
  );
}

/* ── pieces ──────────────────────────────────────────────────────────────── */

function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(2)} s`;
}

function obsDotClass(state: ObsBridgeStatus["state"]): "obsDotOn" | "obsDotWait" | "obsDotOff" {
  if (state === "connected") return "obsDotOn";
  if (state === "connecting") return "obsDotWait";
  return "obsDotOff";
}

/**
 * The connection in one line. Errors are shown verbatim rather than reduced to "failed":
 * every one of them names something the streamer can go and change, and the difference
 * between "OBS is not running" and "the password is wrong" is the whole diagnosis.
 */
function obsStatusText(status: ObsBridgeStatus): string {
  switch (status.state) {
    case "connected":
      return status.note ?? `Connected to OBS${status.version ? ` ${status.version}` : ""}.`;
    case "connecting":
      return "Connecting…";
    case "error":
      return status.retrying ? `${status.message} Retrying…` : status.message;
    default:
      return "Not connected.";
  }
}

/** Degrees with an explicit sign, and a real minus rather than a hyphen. */
function signed(deg: number): string {
  return `${deg > 0 ? "+" : deg < 0 ? "−" : ""}${Math.abs(deg)}°`;
}

/** A named slider row, for panels with more knobs than a Slow–Fast pair can label. */
function TuneRow({
  label,
  value,
  slider,
}: {
  label: string;
  value: string;
  slider: React.ReactNode;
}) {
  return (
    <div className={styles.tuneRow}>
      <span className={styles.tuneLabel}>{label}</span>
      {slider}
      <span className={styles.tuneValue}>{value}</span>
    </div>
  );
}

function swap<T>(list: T[], a: number, b: number): T[] {
  const next = [...list];
  [next[a], next[b]] = [next[b], next[a]];
  return next;
}

function ImagePreview({ image, className }: { image: StoredImage; className?: string }) {
  const url = useObjectUrl(image);
  // eslint-disable-next-line @next/next/no-img-element
  return url ? <img src={url} alt="" className={className} /> : null;
}

/**
 * The stored images, drawn through the same component the overlay uses. Only the object
 * URLs are made here — everything about how it looks lives in `AvatarStage`, so the preview
 * cannot drift from the browser source.
 */
function PreviewStage({
  idle,
  frames,
  speaking,
  avatar,
  captionText = null,
}: {
  idle: StoredImage | null;
  frames: StoredImage[];
  speaking: boolean;
  avatar: AvatarSettings;
  captionText?: string | null;
}) {
  const idleUrl = useObjectUrl(idle);
  const frameUrls = useObjectUrls(frames);
  return (
    <AvatarStage
      idleUrl={idleUrl}
      frameUrls={frameUrls}
      speaking={speaking}
      avatar={avatar}
      captionText={captionText}
      className={styles.stageFill}
    />
  );
}

/**
 * The handles laid over the Talking preview. Transparent to the pointer except for the
 * handles themselves, so dragging one never fights the stage underneath.
 */
function DragLayer({
  caption,
  bob,
  onCaption,
  onBob,
}: {
  caption: { x: number; y: number } | null;
  bob: { anchorX: number; anchorY: number } | null;
  onCaption: (x: number, y: number) => void;
  onBob: (x: number, y: number) => void;
}) {
  const layer = useRef<HTMLDivElement>(null);
  if (!caption && !bob) return null;
  return (
    <div ref={layer} className={styles.dragLayer}>
      {caption && (
        <DragHandle
          layer={layer}
          x={caption.x}
          y={caption.y}
          label="Caption"
          icon={<Move size={13} strokeWidth={2.75} />}
          onMove={onCaption}
          flipLabel={caption.y > 0.82}
        />
      )}
      {bob && (
        <DragHandle
          layer={layer}
          x={bob.anchorX}
          y={bob.anchorY}
          label="Bob anchor"
          icon={<Anchor size={13} strokeWidth={2.75} />}
          onMove={onBob}
          flipLabel={bob.anchorY > 0.82}
        />
      )}
    </div>
  );
}

/** One draggable point, in fractions of the stage. Arrow keys move it 2% at a time. */
function DragHandle({
  layer,
  x,
  y,
  label,
  icon,
  onMove,
  flipLabel,
}: {
  layer: React.RefObject<HTMLDivElement | null>;
  x: number;
  y: number;
  label: string;
  icon: React.ReactNode;
  onMove: (x: number, y: number) => void;
  /** Near the bottom edge the caption under the handle would fall off the tile. */
  flipLabel: boolean;
}) {
  // Where inside the handle it was grabbed. Without it the handle jumps so its centre lands
  // under the cursor on the first move, which reads as the point snapping away from you.
  const grab = useRef({ dx: 0, dy: 0 });
  const dragging = useRef(false);

  function moveTo(clientX: number, clientY: number) {
    const rect = layer.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return;
    onMove(
      clamp01((clientX - grab.current.dx - rect.left) / rect.width),
      clamp01((clientY - grab.current.dy - rect.top) / rect.height),
    );
  }

  return (
    <button
      type="button"
      className={styles.handle}
      style={{ left: `${x * 100}%`, top: `${y * 100}%` }}
      aria-label={`${label} position: ${Math.round(x * 100)}% across, ${Math.round(y * 100)}% down. Drag it, or move it with the arrow keys.`}
      onPointerDown={(e) => {
        const rect = layer.current?.getBoundingClientRect();
        if (!rect) return;
        grab.current = {
          dx: e.clientX - (rect.left + x * rect.width),
          dy: e.clientY - (rect.top + y * rect.height),
        };
        dragging.current = true;
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (dragging.current) moveTo(e.clientX, e.clientY);
      }}
      onPointerUp={() => {
        dragging.current = false;
      }}
      onPointerCancel={() => {
        dragging.current = false;
      }}
      onKeyDown={(e) => {
        const step = 0.02;
        const by: Record<string, [number, number]> = {
          ArrowLeft: [-step, 0],
          ArrowRight: [step, 0],
          ArrowUp: [0, -step],
          ArrowDown: [0, step],
        };
        const delta = by[e.key];
        if (!delta) return;
        e.preventDefault();
        onMove(clamp01(x + delta[0]), clamp01(y + delta[1]));
      }}
    >
      {icon}
      <span className={flipLabel ? styles.handleLabelAbove : styles.handleLabel}>{label}</span>
    </button>
  );
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

function Dropzone({
  title,
  hint,
  buttonLabel,
  onFiles,
}: {
  title: string;
  hint: string;
  buttonLabel: string;
  onFiles: (files: FileList) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  return (
    <div
      className={over ? styles.dropzoneOver : styles.dropzone}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        if (e.dataTransfer.files.length > 0) onFiles(e.dataTransfer.files);
      }}
    >
      <span className={styles.dropTitle}>{title}</span>
      <span className={styles.dropHint}>{hint}</span>
      <button
        type="button"
        className={`btn btn-secondary ${styles.dropBtn}`}
        onClick={() => input.current?.click()}
      >
        {buttonLabel}
      </button>
      <input
        ref={input}
        type="file"
        accept="image/png,image/gif,image/webp,image/jpeg"
        hidden
        onChange={(e) => {
          if (e.target.files?.length) onFiles(e.target.files);
          e.target.value = "";
        }}
      />
    </div>
  );
}

function AddFramesTile({ onFiles }: { onFiles: (files: FileList) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  return (
    <button
      type="button"
      className={over ? styles.addTileOver : styles.addTile}
      onClick={() => input.current?.click()}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        if (e.dataTransfer.files.length > 0) onFiles(e.dataTransfer.files);
      }}
    >
      <Plus size={22} strokeWidth={2.75} color="var(--color-accent-500)" />
      <span>Add frames</span>
      <input
        ref={input}
        type="file"
        multiple
        accept="image/png,image/gif,image/webp,image/jpeg"
        hidden
        onChange={(e) => {
          if (e.target.files?.length) onFiles(e.target.files);
          e.target.value = "";
        }}
      />
    </button>
  );
}
