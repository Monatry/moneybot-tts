"use client";

import { AlertTriangle } from "lucide-react";
import { useEffect, useState } from "react";
import { AppNav } from "@/components/AppNav";
import { DeviceSelect } from "@/components/DeviceSelect";
import { LocalModelControls, ModelProgress } from "@/components/LocalModel";
import { Segmented } from "@/components/Segmented";
import { Slider } from "@/components/Slider";
import { Stepper } from "@/components/Stepper";
import { Toggle } from "@/components/Toggle";
import { VoicePool, VoicePoolEngineNote } from "@/components/VoicePool";
import { Waveform } from "@/components/Waveform";
import { getBot, useBot } from "@/lib/bot";
import { getCustomRewards, type CustomReward } from "@/lib/helix";
import {
  MIN_BITS_CEILING,
  MIN_BITS_FLOOR,
  MIN_DELAY_OPTIONS,
  updateSettings,
  useSettings,
} from "@/lib/settings";
import styles from "./setup.module.css";

const TEST_LINE = "Moneybot is ready to read your chat.";

/** Screen 1c — choose which Twitch events get read, and where the audio goes. */
export function TriggersAudio({
  tokenMissing,
  onFinish,
}: {
  tokenMissing: boolean;
  onFinish: () => void;
}) {
  const settings = useSettings();
  const bot = useBot();
  const [rewards, setRewards] = useState<CustomReward[]>([]);

  const { triggers, audio } = settings;

  // The reward picker the handoff asks for, degrading to free text: Helix only returns
  // rewards the token can see, so an empty list is normal rather than an error.
  useEffect(() => {
    const s = settings.auth;
    if (!s.token || !s.userId) return;
    void getCustomRewards(s.userId, s.token).then(setRewards);
  }, [settings.auth]);

  // The voice list is what synthesis needs; loading it here means the whitelist error shows
  // up on this screen rather than as a silent failure on the first real message.
  useEffect(() => {
    void getBot().ensureVoices();
  }, []);

  function testAudio() {
    const runtime = getBot();
    // Every path that can lead to speech goes through unlock() first — a context created
    // outside a user gesture starts suspended and plays nothing.
    void runtime.player.unlock().then(() => {
      void runtime.player.setSink(audio.outputDeviceId);
      runtime.player.setVolume(audio.masterVolume);
      runtime.enqueueTest(TEST_LINE);
    });
  }

  function finish() {
    updateSettings((prev) => ({ ...prev, setupComplete: true }));
    onFinish();
  }

  return (
    <div className={styles.screen}>
      <AppNav right={<span className={styles.navNote}>First-time setup</span>} />

      <div className={styles.body}>
        <div className={styles.header}>
          <div>
            <h2 style={{ margin: "0 0 4px" }}>What should Moneybot read?</h2>
            <p className={styles.ledeSmall}>
              You can change all of this later from the dashboard.
            </p>
          </div>
        </div>

        {tokenMissing && (
          <div className={styles.warnBanner} role="status">
            <AlertTriangle size={16} strokeWidth={2.75} />
            <span>
              No Twitch token yet. Moneybot can still read chat and cheers anonymously, but
              channel-point redeems stay off until you connect one.
            </span>
          </div>
        )}

        <div className={styles.panels}>
          {/* ── Triggers ─────────────────────────────────────────────── */}
          <section className={styles.panel}>
            <h4 style={{ margin: 0 }}>Triggers</h4>

            <div className={styles.triggerRows}>
              <div className={styles.triggerRow}>
                <div style={{ flex: 1 }}>
                  <div className={styles.rowTitle}>Chat messages</div>
                  <div className={styles.rowSub}>Every message from everyone in chat</div>
                </div>
                <Toggle
                  label="Read chat messages"
                  checked={triggers.chat}
                  onChange={(v) =>
                    updateSettings((p) => ({ ...p, triggers: { ...p.triggers, chat: v } }))
                  }
                />
              </div>

              <div className={`${styles.triggerRow} ${styles.triggerRowStack} ${styles.cheerRow}`}>
                <div className={styles.triggerRowHead}>
                  <div style={{ flex: 1 }}>
                    <div className={styles.rowTitle}>Cheers</div>
                    <div className={styles.rowSub}>Bits messages, loudest first</div>
                  </div>
                  <Toggle
                    label="Read cheers"
                    checked={triggers.cheers.enabled}
                    onChange={(v) =>
                      updateSettings((p) => ({
                        ...p,
                        triggers: { ...p.triggers, cheers: { ...p.triggers.cheers, enabled: v } },
                      }))
                    }
                  />
                </div>
                <div className={styles.subControls} data-off={!triggers.cheers.enabled || undefined}>
                  <span className={styles.subLabel}>Minimum bits</span>
                  <Stepper
                    label="Minimum bits"
                    value={triggers.cheers.minBits}
                    min={MIN_BITS_FLOOR}
                    max={MIN_BITS_CEILING}
                    step={10}
                    disabled={!triggers.cheers.enabled}
                    onChange={(v) =>
                      updateSettings((p) => ({
                        ...p,
                        triggers: { ...p.triggers, cheers: { ...p.triggers.cheers, minBits: v } },
                      }))
                    }
                  />
                  <span className={styles.subHint}>and above get read</span>
                </div>
              </div>

              <div className={`${styles.triggerRow} ${styles.triggerRowStack} ${styles.redeemRow}`}>
                <div className={styles.triggerRowHead}>
                  <div style={{ flex: 1 }}>
                    <div className={styles.rowTitle}>Channel points</div>
                    <div className={styles.rowSub}>One redeem drives the queue</div>
                  </div>
                  <Toggle
                    label="Read channel point redeems"
                    tone="purple"
                    checked={triggers.redeems.enabled}
                    onChange={(v) =>
                      updateSettings((p) => ({
                        ...p,
                        triggers: { ...p.triggers, redeems: { ...p.triggers.redeems, enabled: v } },
                      }))
                    }
                  />
                </div>
                <div
                  className={styles.subControls}
                  data-off={!triggers.redeems.enabled || undefined}
                >
                  <label className={styles.subLabel} htmlFor="reward">
                    Redeem name
                  </label>
                  <input
                    id="reward"
                    className={`input ${styles.rewardInput}`}
                    list={rewards.length > 0 ? "reward-options" : undefined}
                    value={triggers.redeems.rewardName}
                    disabled={!triggers.redeems.enabled}
                    placeholder="Make Moneybot Speak"
                    onChange={(e) =>
                      updateSettings((p) => ({
                        ...p,
                        triggers: {
                          ...p.triggers,
                          redeems: { ...p.triggers.redeems, rewardName: e.target.value },
                        },
                      }))
                    }
                  />
                  {rewards.length > 0 && (
                    <datalist id="reward-options">
                      {rewards.map((r) => (
                        <option key={r.id} value={r.title} />
                      ))}
                    </datalist>
                  )}
                </div>
                {triggers.redeems.enabled && !triggers.redeems.rewardName.trim() && (
                  <p className="error-line" style={{ margin: 0 }}>
                    Name the reward. An empty name matches nothing, so no redeem is read.
                  </p>
                )}
              </div>
            </div>
          </section>

          {/* ── Audio ────────────────────────────────────────────────── */}
          <section className={styles.panel}>
            <h4 style={{ margin: 0 }}>Audio</h4>

            <div className="field">
              <label>Output device</label>
              <DeviceSelect
                value={audio.outputDeviceId}
                onChange={(deviceId) => {
                  updateSettings((p) => ({ ...p, audio: { ...p.audio, outputDeviceId: deviceId } }));
                  void getBot().setOutputDevice(deviceId);
                }}
              />
            </div>

            <div className="field">
              <label>Playback speed</label>
              <div className={styles.sliderRow}>
                <Slider
                  label="Playback speed"
                  min={0.5}
                  max={2}
                  step={0.05}
                  value={audio.playbackRate}
                  ariaValueText={`${audio.playbackRate.toFixed(2)} times`}
                  onChange={(v) =>
                    updateSettings((p) => ({ ...p, audio: { ...p.audio, playbackRate: v } }))
                  }
                />
                <span className={styles.sliderValue}>{audio.playbackRate.toFixed(2)}×</span>
              </div>
            </div>

            <div className="field">
              <label>Minimum delay between messages</label>
              <Segmented
                name="minDelay"
                label="Minimum delay between messages"
                value={audio.minDelayMs}
                options={MIN_DELAY_OPTIONS.map((ms) => ({ value: ms, label: `${ms / 1000}s` }))}
                onChange={(v) =>
                  updateSettings((p) => ({ ...p, audio: { ...p.audio, minDelayMs: v } }))
                }
              />
            </div>

            <LocalModelControls />

            <div className={styles.testCard}>
              <Waveform active={bot.isSpeaking} />
              {/* Renders only while the in-browser model is loading or after it failed, and
                  never at all on a server-engine build. It sits above the Test button
                  because that button is disabled until the voice list exists, and this is
                  the only thing on the screen that says why. */}
              <ModelProgress status={bot.engineStatus} />
              <div className={styles.testRow}>
                <span className={styles.testCaption}>“{TEST_LINE}”</span>
                <button
                  type="button"
                  className={`btn btn-secondary ${styles.testBtn}`}
                  onClick={testAudio}
                  disabled={bot.voices.length === 0}
                >
                  Test audio
                </button>
              </div>
              {bot.voicesError && (
                <div className={styles.accessError}>
                  <strong>{bot.voicesError.message}</strong>
                  {bot.voicesError.detail && <span>{bot.voicesError.detail}</span>}
                </div>
              )}
            </div>
          </section>
        </div>

        {/* Full width, below the two columns rather than inside one: it is a list of up to
            54 chips, and the panel it needs is wider than either column. The list is baked
            into the bundle (lib/voiceCatalogue.ts), so it renders whether or not the engine
            has answered yet — unlike the Test audio button above. */}
        <section className={`${styles.panel} ${styles.voicePanel}`}>
          <VoicePool />
          <VoicePoolEngineNote />
        </section>

        <div className={styles.actions}>
          <button type="button" className={`btn btn-primary ${styles.primaryCta}`} onClick={finish}>
            Finish setup
          </button>
          <span className={styles.footerNote}>
            Settings live in your browser, nothing leaves this machine.
          </span>
        </div>
      </div>
    </div>
  );
}
