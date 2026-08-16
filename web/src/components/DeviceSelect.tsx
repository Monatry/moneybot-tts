"use client";

import { ChevronDown } from "lucide-react";
import { useEffect, useState } from "react";
import { PcmPlayer } from "@/lib/audioPlayer";
import styles from "./DeviceSelect.module.css";

/**
 * Output device picker, populated from `navigator.mediaDevices.enumerateDevices()`.
 *
 * Two browser facts shape this control, and both are surfaced rather than hidden:
 *
 *  1. Device *labels* are withheld until the page has been granted microphone permission —
 *     without it the list is a set of blank entries with opaque ids, which is useless. So
 *     the unpermissioned state is an explicit "Show device names" button rather than a
 *     silently empty dropdown.
 *  2. Choosing an output at all needs `AudioContext.setSinkId`, which is Chromium-only.
 *     Elsewhere the choice is remembered but the OS default is what plays, and the note
 *     under the control says so.
 */
export function DeviceSelect({
  value,
  onChange,
}: {
  value: string;
  onChange: (deviceId: string) => void;
}) {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [needsPermission, setNeedsPermission] = useState(false);
  const [loading, setLoading] = useState(true);
  const [supported, setSupported] = useState(true);

  useEffect(() => {
    setSupported(PcmPlayer.supportsSinkSelection);
    void refresh();
    // Devices come and go while the page is open — a headset unplugged mid-stream should
    // drop out of the list.
    navigator.mediaDevices?.addEventListener("devicechange", refresh);
    return () => navigator.mediaDevices?.removeEventListener("devicechange", refresh);

    async function refresh() {
      if (!navigator.mediaDevices?.enumerateDevices) {
        setLoading(false);
        return;
      }
      const all = await navigator.mediaDevices.enumerateDevices();
      const outputs = all.filter((d) => d.kind === "audiooutput");
      setDevices(outputs);
      setNeedsPermission(outputs.length > 0 && outputs.every((d) => d.label === ""));
      setLoading(false);
    }
  }, []);

  async function grantPermission() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // The stream itself is not wanted — only the permission that unlocks the labels.
      stream.getTracks().forEach((t) => t.stop());
      const all = await navigator.mediaDevices.enumerateDevices();
      const outputs = all.filter((d) => d.kind === "audiooutput");
      setDevices(outputs);
      setNeedsPermission(outputs.every((d) => d.label === ""));
    } catch {
      setNeedsPermission(true);
    }
  }

  return (
    <div>
      <div className={styles.row}>
        <select
          className={styles.select}
          value={value}
          disabled={loading}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="default">
            {loading ? "Looking for devices…" : "System default output"}
          </option>
          {devices
            .filter((d) => d.deviceId && d.deviceId !== "default")
            .map((d, i) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label || `Output ${i + 1}`}
              </option>
            ))}
        </select>
        <ChevronDown size={16} strokeWidth={2.75} className={styles.chevron} aria-hidden />
      </div>

      {needsPermission && (
        <div className={styles.note}>
          <button type="button" className="btn btn-ghost" onClick={grantPermission}>
            Show device names
          </button>
          <span>Your browser hides them until you allow microphone access once.</span>
        </div>
      )}
      {!supported && !loading && (
        <p className="hint-line">
          This browser can&apos;t route audio to a chosen device, so Moneybot will play through
          your system default. Chrome and Edge support it.
        </p>
      )}
    </div>
  );
}
