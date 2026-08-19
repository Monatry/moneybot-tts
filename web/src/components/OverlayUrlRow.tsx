"use client";

import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { obsOverlayUrl } from "@/lib/basePath";
import styles from "./OverlayUrlRow.module.css";

/**
 * The overlay URL, ready to paste into an OBS browser source, with a Copy button.
 *
 * Shared by `ObsGuide` and the Send-to-OBS panel on `/avatar-config` so the two cannot show
 * different URLs — the guide's walkthrough and the panel a streamer actually works in are the
 * same step, and the panel used to build its own string from `appOrigin()`, which keeps the
 * `private.` host a browser source cannot sign in to.
 */
export function OverlayUrlRow({ className }: { className?: string }) {
  // Read after mount rather than during render: `window` does not exist in the server render.
  const [url, setUrl] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => setUrl(obsOverlayUrl()), []);

  // The tick is a confirmation, not a state — it says the click landed, so it expires.
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(t);
  }, [copied]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      // Clipboard access can be refused (no permission, an insecure origin). The URL is
      // selectable text either way, so there is nothing to report — just no tick.
    }
  }

  return (
    <div className={className ? `${styles.urlRow} ${className}` : styles.urlRow}>
      <code className={styles.url}>{url}</code>
      <button type="button" className={styles.copy} onClick={() => void copy()} disabled={!url}>
        {copied ? <Check size={14} strokeWidth={3} /> : <Copy size={14} strokeWidth={2.5} />}
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
