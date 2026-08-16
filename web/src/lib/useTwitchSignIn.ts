"use client";

import { useCallback, useEffect, useState } from "react";
import { updateSettings } from "./settings";
import { beginOAuth, normalizeToken, readStoredState, validateToken } from "./twitchAuth";

/**
 * Drives the Twitch sign-in, both halves of it: the popup flow, and the same-tab fallback
 * that the callback page leaves in sessionStorage when the popup was blocked.
 *
 * Whichever way the token arrives it is validated before being stored, because that call is
 * the only source of two things the app cannot work without — the token owner's login (the
 * IRC username must be *that*, not the channel being watched) and the granted scope list
 * (a token missing `chat:read` connects and is then silently dropped by Twitch).
 */
export interface SignInState {
  busy: boolean;
  error: string | null;
}

export function useTwitchSignIn(onSuccess?: (login: string) => void) {
  const [state, setState] = useState<SignInState>({ busy: false, error: null });

  const applyToken = useCallback(
    async (raw: string): Promise<boolean> => {
      const token = normalizeToken(raw);
      const info = await validateToken(token);
      if (!info) {
        setState({ busy: false, error: "Twitch rejected that token: it is invalid or expired." });
        return false;
      }
      updateSettings((prev) => ({
        ...prev,
        auth: {
          // Only fill the channel from the token owner when the user has not named one:
          // a mod running this for someone else's channel would otherwise have their own
          // login overwrite it.
          channel: prev.auth.channel || info.login,
          token,
          login: info.login,
          userId: info.userId,
          scopes: info.scopes,
        },
      }));
      setState({ busy: false, error: null });
      onSuccess?.(info.login);
      return true;
    },
    [onSuccess],
  );

  // The same-tab fallback: the callback page stashed the token here and navigated back.
  useEffect(() => {
    const raw = sessionStorage.getItem("moneybot.oauth.result");
    if (!raw) return;
    sessionStorage.removeItem("moneybot.oauth.result");
    try {
      const { token, state: returnedState } = JSON.parse(raw) as { token: string; state: string };
      // Same check the popup path makes: a response carrying the wrong state did not
      // originate from the request this app made.
      if (returnedState !== readStoredState()) {
        setState({ busy: false, error: "Sign-in state mismatch. Please try again." });
        return;
      }
      setState({ busy: true, error: null });
      void applyToken(token);
    } catch {
      /* nothing usable was stashed */
    }
  }, [applyToken]);

  const signIn = useCallback(async () => {
    setState({ busy: true, error: null });
    try {
      const token = await beginOAuth();
      await applyToken(token);
    } catch (err) {
      setState({ busy: false, error: (err as Error).message });
    }
  }, [applyToken]);

  return { ...state, signIn, applyToken, setError: (e: string | null) => setState((s) => ({ ...s, error: e })) };
}
