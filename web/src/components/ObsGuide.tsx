"use client";

import { X } from "lucide-react";
import { useEffect, useRef } from "react";
import { withBasePath } from "@/lib/basePath";
import { OverlayUrlRow } from "./OverlayUrlRow";
import styles from "./ObsGuide.module.css";

/**
 * How to point OBS at the overlay, with the two screenshots that make it a 30-second job.
 *
 * This exists because the OBS route is the one part of the app that cannot be made obvious
 * from inside the app: every step of it happens in another program, and the payoff (a
 * browser source instead of a captured window) is invisible until it is already working. So
 * the reasoning is stated first — a streamer who does not know *why* they are pasting a
 * password into a text field will reasonably decide not to.
 *
 * A native `<dialog>` in modal mode, like `ConfirmDialog`: focus trapping, Escape and the
 * inert backdrop come from the platform. Unlike that one it scrolls, because the screenshots
 * are the point and a laptop viewport is not tall enough for them.
 */
export function ObsGuide({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  if (!open) return null;

  return (
    <dialog
      ref={ref}
      className={styles.dialog}
      aria-labelledby="obs-guide-title"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        // A click landing on the dialog element itself is a click on the backdrop — the
        // content is all in child elements.
        if (e.target === ref.current) onClose();
      }}
    >
      <header className={styles.head}>
        <h3 id="obs-guide-title" className={styles.title}>
          Sending the avatar to OBS
        </h3>
        <button type="button" className={styles.close} onClick={onClose} aria-label="Close">
          <X size={16} strokeWidth={3} />
        </button>
      </header>

      <div className={styles.scroll}>
        <p className={styles.lede}>
          You can capture the avatar window with a Window Capture and it will work. Connecting
          OBS directly is better for two reasons, and both of them bite during a stream rather
          than while you are setting up.
        </p>

        <div className={styles.whyGrid}>
          <div className={styles.why}>
            <h4 className={styles.whyTitle}>It never stops animating</h4>
            <p>
              A browser stops drawing a window it thinks you cannot see — another window in
              front of it is enough. The avatar freezes mid-sentence, and it happens exactly
              when you have alt-tabbed to do something else. OBS renders a browser source
              off-screen, so there is nothing to hide it from.
            </p>
          </div>
          <div className={styles.why}>
            <h4 className={styles.whyTitle}>Transparency actually works</h4>
            <p>
              A browser source composites the avatar&rsquo;s real transparency. Chroma key has
              to guess where the green ends, and stream compression blurs exactly those edges
              — which is where the green fringing and chewed-up outlines come from.
            </p>
          </div>
        </div>

        <ol className={styles.steps}>
          <li>
            <h4 className={styles.stepTitle}>Open OBS&rsquo;s WebSocket settings</h4>
            <p>
              In OBS: <strong>Tools ▸ WebSocket Server Settings</strong>. It is built in — there
              is nothing to install.
            </p>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              className={styles.shot}
              src={withBasePath("/obs-websocket-menu.png")}
              alt="The OBS Tools menu with WebSocket Server Settings circled."
            />
          </li>

          <li>
            <h4 className={styles.stepTitle}>Turn it on and copy the password</h4>
            <p>
              Tick <strong>Enable WebSocket server</strong>, then click{" "}
              <strong>Show Connect Info</strong> and use the <strong>Copy</strong> button next
              to Server Password. Ignore the Server IP and the QR code — this app talks to OBS
              on this machine, never over the network.
            </p>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              className={styles.shot}
              src={withBasePath("/obs-websocket-password.png")}
              alt="OBS WebSocket Server Settings with Show Connect Info and the password Copy button marked."
            />
            <p className={styles.aside}>
              If <strong>Enable Authentication</strong> is off there is no password to copy —
              leave the field here empty.
            </p>
          </li>

          <li>
            <h4 className={styles.stepTitle}>Paste it here and connect</h4>
            <p>
              Paste into <strong>Password</strong>, leave the URL at its default, and switch{" "}
              <strong>Connect to OBS</strong> on. The dot goes green once OBS answers.
            </p>
          </li>

          <li>
            <h4 className={styles.stepTitle}>Add the browser source</h4>
            <p>
              In OBS, add a <strong>Browser</strong> source and paste this URL into it. Set its
              width and height to the size you want the avatar drawn at. Leave{" "}
              <strong>Shutdown source when not visible</strong> unticked — that setting is the
              one thing that can still stop it.
            </p>
            <OverlayUrlRow className={styles.urlRow} />
          </li>

          <li>
            <h4 className={styles.stepTitle}>Send the avatar over</h4>
            <p>
              Click <strong>Send avatar now</strong> once. OBS runs its own browser with its own
              storage, so the images have to be handed across — after that it remembers them,
              and saving on this screen keeps them up to date.
            </p>
          </li>

          <li>
            <h4 className={styles.stepTitle}>Switch the background to transparent</h4>
            <p>
              Now that it composites properly, turn on <strong>Transparent background</strong> in
              the Overlay background panel further down this page, and delete any chroma key
              filter you were using.
            </p>
          </li>
        </ol>
      </div>

      <div className={styles.actions}>
        <button type="button" className="btn btn-primary" onClick={onClose} autoFocus>
          Got it
        </button>
      </div>
    </dialog>
  );
}
