"use client";

import { Volume2, VolumeX } from "lucide-react";
import { Slider } from "@/components/Slider";
import { Toggle } from "@/components/Toggle";
import { updateSettings, type Settings } from "@/lib/settings";
import styles from "./dashboard.module.css";

/**
 * Master volume and the three source toggles.
 *
 * Everything here applies instantly and persists — there is no Save on the dashboard. The
 * source toggles deliberately do *not* retro-filter what is already queued: turning cheers
 * off stops new ones arriving, it does not delete the ones a viewer already paid for.
 */
export function ControlBar({
  settings,
  onVolumeChange,
}: {
  settings: Settings;
  onVolumeChange: (v: number) => void;
}) {
  const volume = Math.round(settings.audio.masterVolume * 100);

  return (
    <div className={styles.controlBar}>
      <div className={styles.volumeBlock}>
        <div className={styles.microLabel}>Master volume</div>
        <div className={styles.volumeRow}>
          <span className={styles.volumeIcon}>
            {volume === 0 ? (
              <VolumeX size={16} strokeWidth={2.75} />
            ) : (
              <Volume2 size={16} strokeWidth={2.75} />
            )}
          </span>
          <Slider
            label="Master volume"
            min={0}
            max={100}
            step={1}
            value={volume}
            ariaValueText={`${volume} percent`}
            onChange={(v) => onVolumeChange(v / 100)}
          />
          <span className={styles.volumeValue}>{volume}</span>
        </div>
      </div>

      <div className={styles.controlDivider} />

      <div>
        <div className={styles.microLabel}>Sources</div>
        <div className={styles.sourceToggles}>
          <SourcePill
            label="Chat"
            on={settings.triggers.chat}
            onChange={(v) => updateSettings((p) => ({ ...p, triggers: { ...p.triggers, chat: v } }))}
          />
          <SourcePill
            label="Bits"
            on={settings.triggers.cheers.enabled}
            onChange={(v) =>
              updateSettings((p) => ({
                ...p,
                triggers: { ...p.triggers, cheers: { ...p.triggers.cheers, enabled: v } },
              }))
            }
          />
          <SourcePill
            label="Redeems"
            on={settings.triggers.redeems.enabled}
            onChange={(v) =>
              updateSettings((p) => ({
                ...p,
                triggers: { ...p.triggers, redeems: { ...p.triggers.redeems, enabled: v } },
              }))
            }
          />
        </div>
      </div>
    </div>
  );
}

function SourcePill({
  label,
  on,
  onChange,
}: {
  label: string;
  on: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className={on ? styles.sourcePillOn : styles.sourcePillOff}>
      <span className={styles.sourceLabel}>{label}</span>
      <Toggle label={`Read ${label.toLowerCase()}`} size="sm" checked={on} onChange={onChange} />
    </div>
  );
}
