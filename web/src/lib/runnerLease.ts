"use client";

/**
 * Which page is allowed to run the bot.
 *
 * Two clients both running is not a cosmetic problem: it is two IRC connections and two
 * EventSub *sessions*, so every chat line and every redemption is spoken twice (see the
 * teardown note in lib/twitchEventSub.ts). Since the overlay can now start the runtime by
 * itself (lib/avatarRunner.ts) while a dashboard may also be open, something has to arbitrate.
 *
 * **A Web Lock is that something.** `navigator.locks` is a real mutex whose holder is
 * released *by the browser* the moment the page holding it dies — closed, crashed, or killed
 * with the machine. There is no timeout to pick, no stale-lock cleanup, and no window in
 * which two pages both believe they are the runner. Every client that starts the bot claims
 * the same lock, dashboard included, and whoever holds it is the runner.
 *
 * Three behaviours are worth knowing about:
 *
 * - The lock is **held for as long as the request callback's promise is pending**, so holding
 *   it means returning a promise that only settles when we choose to let go.
 * - `ifAvailable` answers "is it free?" *and takes it if so*, in one step, with no waiting.
 *   That is what lets a page decide what to be on its first tick instead of after a timeout.
 * - A plain queued request is the takeover path: it is granted when the current holder dies,
 *   so promotion needs no polling at all.
 *
 * **The one thing it cannot do is cross a browser profile.** Locks are per-origin *per
 * profile*, and an overlay running as an OBS browser source lives in CEF's own profile — so
 * an OBS overlay and a dashboard in the streamer's desktop browser each hold an uncontended
 * lock and neither can see the other. That single pair is what the `bot-alive` heartbeat in
 * lib/avatarRunner.ts exists for, and nothing else. Where the two *do* share a profile — two
 * overlay sources in two scenes, an overlay window beside the dashboard, or a dashboard in an
 * OBS custom browser dock, which shares CEF's profile with the sources — this file decides it
 * and the heartbeat never comes into it.
 */

const LOCK_NAME = "moneybot.runner";

/** Older browsers, and any non-secure context. The caller falls back to the heartbeat alone. */
export function locksSupported(): boolean {
  return typeof navigator !== "undefined" && "locks" in navigator && !!navigator.locks;
}

export interface LeaseHandlers {
  /** This page now holds the lock. May fire more than once: lost, then granted again. */
  onAcquired: () => void;
  /**
   * The lock is no longer ours because somebody else took it (a dashboard starting up).
   * Stop the runtime here. A fresh request is queued straight away, so if the thief goes
   * away `onAcquired` fires again.
   */
  onStolen: () => void;
}

export interface RunnerLease {
  /** Give up the lock and stop trying to get it back. */
  release(): void;
  readonly held: boolean;
}

/**
 * Claim the runner lock, and keep claiming it.
 *
 * `steal` is for the dashboard: it is the client a human deliberately opened, so it wins over
 * an overlay that started itself. Stealing rejects the previous holder's request promise with
 * `AbortError`, which is how that page learns to stand down.
 */
export function claimRunnerLease(
  handlers: LeaseHandlers,
  options: { steal?: boolean } = {},
): RunnerLease {
  let disposed = false;
  let held = false;
  /** Resolving this is what releases a lock we are holding. */
  let letGo: (() => void) | null = null;

  const lease: RunnerLease = {
    release() {
      disposed = true;
      letGo?.();
      letGo = null;
      held = false;
    },
    get held() {
      return held;
    },
  };

  if (!locksSupported()) {
    // No mutex available, so assume the role and let the heartbeat sort out duplicates. The
    // alternative — refusing to run — would mean no TTS at all on a browser that cannot
    // arbitrate, which is worse than the double-speak this was protecting against.
    held = true;
    handlers.onAcquired();
    return lease;
  }

  /**
   * One `request`. Resolves true if it was granted and has since been released by us, false
   * if `ifAvailable` found it taken, and throws `AbortError` if it was stolen from under us.
   */
  const hold = async (mode: LockOptions): Promise<boolean> => {
    let granted = false;
    await navigator.locks.request(LOCK_NAME, mode, async (lock) => {
      if (!lock) return; // ifAvailable and somebody else has it
      granted = true;
      if (disposed) return;
      held = true;
      handlers.onAcquired();
      await new Promise<void>((resolve) => {
        letGo = resolve;
      });
    });
    return granted;
  };

  const pursue = async () => {
    try {
      if (options.steal) {
        await hold({ steal: true });
      } else if (!(await hold({ ifAvailable: true }))) {
        // Taken. Stay passive, but queue a plain request — it is granted the instant the
        // holder's page goes away, which is the whole takeover mechanism.
        await hold({});
      }
    } catch {
      // Stolen. `AbortError` is the only thing that lands here in practice; treating any
      // failure the same way is right regardless, since either way we are not the runner.
      held = false;
      letGo = null;
      if (disposed) return;
      handlers.onStolen();
      void pursue();
      return;
    }
    // Released. The only thing that resolves `letGo` is `release()`, so reaching here means
    // this page is done wanting the role — there is deliberately no re-request, which would
    // spin if a browser ever granted and dropped a request without running the callback.
    held = false;
  };

  void pursue();
  return lease;
}
