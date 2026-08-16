"use client";

/**
 * The browser engine's two visible surfaces: how the model load is going, and what backend
 * it runs on.
 *
 * Both render nothing at all on a server-engine build. That is why they are components
 * rather than branches at the call sites — the setup and dashboard screens are shared
 * between the two builds, and `NEXT_PUBLIC_TTS_ENGINE` folds to a literal at build time, so
 * an early return here removes them from the server build entirely rather than shipping a
 * runtime check to every screen.
 */

import { AlertTriangle } from "lucide-react";
import { getBot, useBot } from "@/lib/bot";
import { updateSettings, useSettings } from "@/lib/settings";
import { IS_BROWSER_ENGINE } from "@/lib/ttsEngine";
import type { EngineStatus } from "@/lib/ttsClient";
import styles from "./LocalModel.module.css";

const DEVICE_OPTIONS = [
  { value: "auto", label: "Automatic" },
  { value: "webgpu", label: "Graphics card (WebGPU)" },
  { value: "wasm", label: "Processor (WebAssembly)" },
] as const;

const DTYPE_OPTIONS = [
  { value: "auto", label: "Automatic" },
  { value: "fp32", label: "Full — fp32 (largest, best)" },
  { value: "fp16", label: "Half — fp16" },
  { value: "q8", label: "Compressed — q8 (smallest usable)" },
  { value: "q4f16", label: "Very compressed — q4f16" },
  { value: "q4", label: "Very compressed — q4" },
] as const;

/**
 * The load bar. Shows only while the model is actually coming down or warming up, and
 * after a failure — a ready model needs no ornament, and a bar that lingers at 100% reads
 * as something still happening.
 *
 * `tone="banner"` is the dashboard's full-width strip; the default is the inline block on
 * the setup screen.
 */
export function ModelProgress({
  status,
  tone = "inline",
}: {
  status: EngineStatus;
  tone?: "inline" | "banner";
}) {
  if (!IS_BROWSER_ENGINE) return null;
  if (status.phase === "unused" || status.phase === "ready" || status.phase === "idle") return null;

  if (status.phase === "error") {
    return (
      <div className={tone === "banner" ? styles.errorBanner : styles.errorInline} role="alert">
        <AlertTriangle size={16} strokeWidth={2.75} aria-hidden />
        <div>
          <strong>Kokoro could not start in this browser.</strong>
          <div className={styles.errorDetail}>{status.detail}</div>
        </div>
      </div>
    );
  }

  return (
    <div className={tone === "banner" ? styles.banner : styles.inline} role="status">
      <div className={styles.headline}>
        <span>Loading the voice model</span>
        <span className={`numeric ${styles.percent}`}>{status.percent}%</span>
      </div>
      <div className={styles.track}>
        <div className={styles.fill} style={{ width: `${status.percent}%` }} />
      </div>
      <div className={styles.caption}>
        {status.detail}
        {" · "}
        It only downloads once; after this it starts from your browser&rsquo;s cache.
      </div>
    </div>
  );
}

/**
 * Backend and precision. Changing either reloads the model, because an ONNX session is
 * built around one backend and cannot be re-targeted — the reload is immediate rather than
 * behind an Apply button, since the alternative is a control whose displayed value is not
 * the one synthesising.
 *
 * Weights already fetched are not fetched again — the browser's cache is keyed by file, and
 * only a precision change asks for files it has not seen — so switching device costs the
 * warm-up and nothing else.
 */
export function LocalModelControls() {
  const settings = useSettings();
  const state = useBot();

  if (!IS_BROWSER_ENGINE) return null;

  const { localTts } = settings;
  const backend = state.engineStatus.backend;
  const busy = state.engineStatus.phase === "loading";

  return (
    <div className="field">
      <label htmlFor="tts-device">Voice model</label>
      <p className={styles.lede}>
        Kokoro runs on this machine, in this tab. Nothing you or your chat says is sent
        anywhere.
      </p>

      <div className={styles.controlRow}>
        <select
          id="tts-device"
          className={`input ${styles.select}`}
          value={localTts.device}
          disabled={busy}
          onChange={(e) => {
            updateSettings((p) => ({
              ...p,
              localTts: { ...p.localTts, device: e.target.value as typeof localTts.device },
            }));
            void getBot().reloadEngine();
          }}
        >
          {DEVICE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>

        <select
          aria-label="Model precision"
          className={`input ${styles.select}`}
          value={localTts.dtype}
          disabled={busy}
          onChange={(e) => {
            updateSettings((p) => ({
              ...p,
              localTts: { ...p.localTts, dtype: e.target.value as typeof localTts.dtype },
            }));
            void getBot().reloadEngine();
          }}
        >
          {DTYPE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>

      {backend && (
        <p className={styles.backendNote}>
          Running on <strong>{backend.device === "webgpu" ? "your graphics card" : "your processor"}</strong>{" "}
          at <span className="numeric">{backend.dtype}</span>.
          {backend.fellBackFrom && (
            <>
              {" "}
              <span className={styles.fallbackNote}>
                WebGPU was tried first and failed ({backend.fellBackFrom}), so this fell back to
                the processor.
              </span>
            </>
          )}
        </p>
      )}
    </div>
  );
}
