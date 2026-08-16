"use client";

/**
 * Twitch application identity and the implicit ("token") grant.
 *
 * The client ID is configuration, not a constant: it comes from
 * `NEXT_PUBLIC_TWITCH_CLIENT_ID`, set in `./.env` (copy `.env.example`). It is public by
 * design — it travels in the authorize URL — unlike a client secret, which this app never
 * holds or needs, so `NEXT_PUBLIC_` giving it to the browser costs nothing. That also means
 * it is inlined at *build* time: changing it needs `docker compose up -d --build`, not a
 * restart, exactly like `NEXT_PUBLIC_BASE_PATH`.
 *
 * There is deliberately no default. Which app the token is issued for decides which redirect
 * URLs are registered and who can revoke it, so a fallback onto someone else's app ID would
 * surface as a `redirect_mismatch` a long way from its cause. Unset, compose refuses to
 * build and `npm run dev` fails the sign-in with a message naming the variable.
 *
 * The desktop build redirected to an HttpListener on http://localhost:21335. A website
 * redirects to its own origin instead, so `REDIRECT_PATH` under whatever origin the app is
 * served from has to be registered as an OAuth Redirect URL on the Twitch app — Twitch
 * compares `redirect_uri` as a raw string, so http://localhost:3000/auth/callback and
 * https://tts.example.com/auth/callback are two separate registrations and a missing one is
 * a `redirect_mismatch`. See README, "Twitch app setup".
 *
 * The base path counts as part of that raw string: mounted under /moneytts the registered
 * URL is https://host/moneytts/auth/callback, and the un-prefixed one will not match.
 */

import { appOrigin } from "./basePath";

/** The configured application ID, or "" when the build was given none. */
export const TWITCH_CLIENT_ID = process.env.NEXT_PUBLIC_TWITCH_CLIENT_ID ?? "";

/**
 * The same value, for the two places that cannot proceed without one. Twitch answers a
 * missing `client_id` with its own generic error page, and Helix with a bare 401, so this
 * turns a misconfigured build into a message that names what to set instead.
 */
export function requireClientId(): string {
  if (!TWITCH_CLIENT_ID) {
    throw new Error(
      "No Twitch client ID is configured. Set NEXT_PUBLIC_TWITCH_CLIENT_ID in web/.env and rebuild.",
    );
  }
  return TWITCH_CLIENT_ID;
}

export const REDIRECT_PATH = "/auth/callback";

/**
 * Scopes requested during sign-in.
 *
 * `chat:read` is not optional once a token exists: the token doubles as the IRC password,
 * and Twitch rejects a token without it with "Login authentication failed" and then drops
 * the socket — which reaches the app as a bare WebSocket close, looking like a network
 * fault rather than an authorization one. `channel:read:redemptions` is what EventSub needs
 * for channel-point redemptions. `bits:read` is what the design's setup screen promises the
 * request button asks for.
 *
 * Tokens issued before a scope was added keep working for everything else, which is why
 * `validateToken` checks the returned scope list rather than assuming.
 */
export const TWITCH_SCOPES = ["chat:read", "bits:read", "channel:read:redemptions"];

export function redirectUri(): string {
  return `${appOrigin()}${REDIRECT_PATH}`;
}

export function authorizeUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: requireClientId(),
    redirect_uri: redirectUri(),
    response_type: "token",
    scope: TWITCH_SCOPES.join(" "),
    force_verify: "true",
    state,
  });
  return `https://id.twitch.tv/oauth2/authorize?${params}`;
}

export interface TokenInfo {
  login: string;
  userId: string;
  clientId: string;
  scopes: string[];
  expiresIn: number;
}

/**
 * `GET https://id.twitch.tv/oauth2/validate`. This is what tells an expired token apart
 * from one that is merely missing a scope, and it is also the only place the token's own
 * owner login comes from — the IRC username must be that login, not the channel being
 * watched. The two only coincide when the broadcaster is the one signed in.
 *
 * Returns null for any invalid or expired token.
 */
export async function validateToken(token: string): Promise<TokenInfo | null> {
  try {
    const res = await fetch("https://id.twitch.tv/oauth2/validate", {
      headers: { Authorization: `OAuth ${token}` },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      login?: string;
      user_id?: string;
      client_id?: string;
      scopes?: string[];
      expires_in?: number;
    };
    if (!body.login || !body.user_id) return null;
    return {
      login: body.login,
      userId: body.user_id,
      clientId: body.client_id ?? "",
      scopes: body.scopes ?? [],
      expiresIn: body.expires_in ?? 0,
    };
  } catch {
    return null;
  }
}

export function canReadChat(info: TokenInfo | null): boolean {
  return !!info?.scopes.includes("chat:read");
}

export function canReadRedemptions(info: TokenInfo | null): boolean {
  return !!info?.scopes.includes("channel:read:redemptions");
}

/** Strips the `oauth:` prefix a pasted token usually carries. Twitch's APIs want it bare. */
export function normalizeToken(raw: string): string {
  return raw.trim().replace(/^oauth:/i, "");
}

const STATE_KEY = "moneybot.oauth.state";

/**
 * Opens the Twitch consent screen in a popup and resolves with the token.
 *
 * Twitch returns the token in the URL *fragment*, which is never sent to a server — so the
 * callback route is a page, not an API route, and it reads `location.hash` in the browser
 * and posts the result back here. The state is stashed in sessionStorage rather than kept
 * in a closure so the callback page can check it even if the popup was blocked and the flow
 * fell back to a full-page redirect.
 */
export function beginOAuth(): Promise<string> {
  const state = crypto.randomUUID().replace(/-/g, "");
  sessionStorage.setItem(STATE_KEY, state);
  const url = authorizeUrl(state);

  return new Promise<string>((resolve, reject) => {
    const popup = window.open(url, "moneybot-twitch-auth", "width=520,height=760");

    if (!popup) {
      // Popup blocked. Fall back to navigating this tab; the callback page routes back to
      // wherever the user started, so the promise below simply never settles.
      sessionStorage.setItem("moneybot.oauth.return", window.location.pathname);
      window.location.href = url;
      return;
    }

    const cleanup = () => {
      window.removeEventListener("message", onMessage);
      clearInterval(closedTimer);
    };

    const onMessage = (ev: MessageEvent) => {
      if (ev.origin !== window.location.origin) return;
      const data = ev.data as { source?: string; token?: string; state?: string; error?: string };
      if (data?.source !== "moneybot-oauth") return;
      cleanup();
      popup.close();
      if (data.error) {
        reject(new Error(`Twitch rejected the request: ${data.error}`));
      } else if (data.state !== state) {
        // Not the response to the request we just made — never accept the token from it.
        reject(new Error("Sign-in state mismatch. Please try again."));
      } else if (data.token) {
        resolve(data.token);
      } else {
        reject(new Error("No token came back from Twitch."));
      }
    };

    window.addEventListener("message", onMessage);

    const closedTimer = window.setInterval(() => {
      if (popup.closed) {
        cleanup();
        reject(new Error("Sign-in window was closed before it finished."));
      }
    }, 500);
  });
}

export function readStoredState(): string | null {
  return sessionStorage.getItem(STATE_KEY);
}
