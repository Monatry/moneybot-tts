"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { AvatarSettings } from "@/lib/settings";
import styles from "./AvatarStage.module.css";

/**
 * The avatar exactly as the overlay paints it.
 *
 * Shared by `/avatar` and the preview on `/avatar-config` so that the preview cannot drift
 * from the browser source — the two used to be separate implementations of the same layer
 * stack, and the effects below (crossfade, caption placement, the bob anchor) are all things
 * a streamer sets by looking at the preview and trusting it.
 *
 * It fills whatever box it is given, and every size it draws is a fraction of that box's
 * height, so a 200 px preview tile and a 1080p browser source show the same composition.
 */
export function AvatarStage({
  idleUrl,
  frameUrls,
  speaking,
  avatar,
  captionText,
  className,
}: {
  idleUrl: string | null;
  frameUrls: string[];
  /**
   * Samples are reaching the device — not "a message is in progress". Animating off the
   * request would flap the mouth over the silence before the first chunk arrives.
   */
  speaking: boolean;
  avatar: AvatarSettings;
  /** The line being read. Drawn only when `avatar.caption.enabled`. */
  captionText: string | null;
  className?: string;
}) {
  const root = useRef<HTMLDivElement>(null);
  const stack = useRef<HTMLDivElement>(null);
  const [index, setIndex] = useState(0);
  const height = useElementHeight(root);

  // Cycle only while speaking, and only when there is more than one frame to cycle through.
  // The index is deliberately *not* reset when speaking stops: the frame it stopped on is
  // what fades out, and blanking it would make the talking group fade from nothing.
  useEffect(() => {
    if (!speaking || frameUrls.length < 2) return;
    const timer = window.setInterval(
      () => setIndex((i) => (i + 1) % frameUrls.length),
      Math.max(1, Math.round(1000 / avatar.fps)),
    );
    return () => clearInterval(timer);
  }, [speaking, frameUrls.length, avatar.fps]);

  const talking = speaking && frameUrls.length > 0;
  // Always exactly one frame lit inside the talking group; whether it is *seen* is the
  // group's opacity, which is the thing that crossfades — in both directions.
  const active = frameUrls.length > 0 ? index % frameUrls.length : -1;

  const fade = avatar.crossfade.enabled ? `opacity ${avatar.crossfade.ms}ms ease-in-out` : "none";

  const { bob } = avatar;
  // The bob imitates talking, so it runs while a line is being read and rests otherwise.
  useBob(stack, bob, bob.enabled && speaking);
  const stackStyle: CSSProperties = {
    transformOrigin: `${bob.anchorX * 100}% ${bob.anchorY * 100}%`,
    // The pose between bobs. A running animation outranks an inline declaration, so this is
    // only ever seen while the bob is at rest — and without it a bob that rests off zero
    // would snap upright the moment the line finished.
    transform: bob.enabled
      ? `rotate(${(bob.flip ? -1 : 1) * bob.minAngle}deg)`
      : undefined,
  };

  const caption = avatar.caption;
  const captionStyle: CSSProperties = {
    left: `${caption.x * 100}%`,
    top: `${caption.y * 100}%`,
    // Translated by the same fractions the position uses, so the caption's own box shrinks
    // inward at the edges: at x=0 its left edge sits on the left edge instead of hanging
    // half of itself off the frame.
    transform: `translate(${-caption.x * 100}%, ${-caption.y * 100}%)`,
    fontSize: `${Math.max(1, (height * caption.size) / 100)}px`,
  };

  return (
    <div ref={root} className={className ? `${styles.stage} ${className}` : styles.stage}>
      <div ref={stack} className={styles.stack} style={stackStyle}>
        {/* Every frame is rendered and only one is made visible, rather than swapping a
            single `src`. A src swap makes the browser decode the image again on every tick —
            twelve decodes a second, for hours — and shows a blank gap while it does. */}
        {idleUrl && (
          <div className={styles.group} style={{ opacity: talking ? 0 : 1, transition: fade }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={idleUrl} alt="" className={styles.layer} />
          </div>
        )}
        {frameUrls.length > 0 && (
          <div className={styles.group} style={{ opacity: talking ? 1 : 0, transition: fade }}>
            {frameUrls.map((url, i) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={url}
                src={url}
                alt=""
                className={styles.layer}
                style={{ opacity: i === active ? 1 : 0 }}
              />
            ))}
          </div>
        )}
      </div>

      {caption.enabled && captionText && (
        <p className={styles.caption} style={captionStyle}>
          {captionText}
        </p>
      )}
    </div>
  );
}

/**
 * The bob: one Web Animations run per swing, each with its own speed.
 *
 * Started from here rather than written as a CSS animation because the speed is re-rolled
 * every time a bob starts. A CSS animation takes one duration up front, and writing a new
 * `animation-duration` onto a running one rescales its elapsed time rather than restarting
 * it, which shows up as the avatar jumping mid-swing. Chaining single runs off `finished`
 * instead means every roll begins from rest, where a change is invisible.
 *
 * The keyframes are the shape: out to the angle over `attackMs`, back to rest over
 * `decayMs`, easing set per segment so the two halves stay unequal. `playbackRate` carries
 * the roll, so the shape is written once and only its tempo varies.
 *
 * The settings are read through a ref at the top of each swing rather than being effect
 * dependencies, so that a slider being dragged on the config screen does not cancel and
 * restart the swing on every input event — which pins the avatar near 0° for as long as the
 * drag lasts. A change lands on the next swing instead, which is also where a re-rolled
 * speed lands.
 */
function useBob(
  ref: React.RefObject<HTMLElement | null>,
  bob: AvatarSettings["bob"],
  running: boolean,
) {
  const latest = useRef(bob);
  useEffect(() => {
    latest.current = bob;
  }, [bob]);

  useEffect(() => {
    const el = ref.current;
    if (!el || !running || typeof el.animate !== "function") return;

    let current: Animation | null = null;
    let cancelled = false;

    const swing = () => {
      if (cancelled) return;
      const { angle, minAngle, flip, attackMs, decayMs, speedMin, speedMax } = latest.current;
      const total = attackMs + decayMs;
      const sign = flip ? -1 : 1;
      const rest = `rotate(${sign * minAngle}deg)`;
      const animation = el.animate(
        [
          { transform: rest, offset: 0, easing: "ease-out" },
          {
            transform: `rotate(${sign * angle}deg)`,
            offset: attackMs / total,
            easing: "ease-in-out",
          },
          { transform: rest, offset: 1 },
        ],
        { duration: total },
      );
      animation.playbackRate = speedMin + Math.random() * Math.max(0, speedMax - speedMin);
      current = animation;
      // `finished` rejects on cancel, which is exactly what unmounting does — swallow it
      // rather than letting an unhandled rejection out of a cosmetic animation.
      animation.finished.then(swing).catch(() => {});
    };
    swing();

    return () => {
      cancelled = true;
      current?.cancel();
    };
  }, [ref, running]);
}

/**
 * The rendered height of the stage, for the caption's font size.
 *
 * Measured rather than expressed in a viewport or container unit: the overlay is the whole
 * window but the preview is a tile inside a page, and `cqh` needs a container-type this
 * would have to declare on both. One observer is cheaper than that, and it is the only
 * thing on this component that touches layout.
 *
 * `useEffect`, not `useLayoutEffect`: both pages that use this are prerendered, and React
 * warns about a layout effect on the server. The caption is only drawn while a line is being
 * read, which is long after the first paint the measurement would have missed.
 */
function useElementHeight(ref: React.RefObject<HTMLElement | null>): number {
  const [height, setHeight] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setHeight(el.clientHeight);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setHeight(el.clientHeight));
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);

  return height;
}
