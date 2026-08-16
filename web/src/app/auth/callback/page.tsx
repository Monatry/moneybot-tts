"use client";

import { useEffect, useState } from "react";
import { Coin } from "@/components/Coin";
import { withBasePath } from "@/lib/basePath";

/**
 * Where Twitch sends the browser back after consent.
 *
 * Twitch returns an implicit-flow token in the URL *fragment*, which is never transmitted
 * to a server — so this has to be a page rather than an API route. It reads
 * `location.hash` here in the browser, posts the result to the window that opened it, and
 * closes. When the popup was blocked and the flow ran in this same tab instead, there is no
 * opener, so it stashes the token and navigates back to wherever the flow started.
 *
 * The fragment is scrubbed from the address bar immediately either way: leaving a live
 * access token in `location.hash` puts it in the session history.
 */
export default function AuthCallback() {
  const [message, setMessage] = useState("Completing sign-in…");

  useEffect(() => {
    const params = new URLSearchParams(window.location.hash.slice(1));
    const token = params.get("access_token");
    const state = params.get("state") ?? "";
    const error = params.get("error_description") ?? params.get("error");

    window.history.replaceState(null, "", window.location.pathname);

    if (window.opener && window.opener !== window) {
      window.opener.postMessage(
        { source: "moneybot-oauth", token, state, error },
        window.location.origin,
      );
      setMessage(error ? `Authorization failed: ${error}` : "Done, you can close this tab.");
      // The opener closes the popup once it has the token; this is the fallback for the
      // case where it never got the message.
      window.setTimeout(() => window.close(), 1500);
      return;
    }

    // Same-tab fallback: no opener to post to, so hand the token over through
    // sessionStorage and go back where the user started.
    if (error) {
      setMessage(`Authorization failed: ${error}`);
      return;
    }
    if (token) {
      sessionStorage.setItem("moneybot.oauth.result", JSON.stringify({ token, state }));
      // The stored value is a `location.pathname`, so it already carries the base path;
      // only the fallback has to be prefixed. This is a raw navigation, not the router.
      const back = sessionStorage.getItem("moneybot.oauth.return") || withBasePath("/setup");
      sessionStorage.removeItem("moneybot.oauth.return");
      window.location.replace(back);
      return;
    }
    setMessage("No token came back from Twitch. Close this tab and try again.");
  }, []);

  return (
    <main
      style={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 18,
        background: "var(--color-surface)",
        textAlign: "center",
        padding: 24,
      }}
    >
      <Coin size={46} />
      <p style={{ margin: 0, color: "var(--text-muted-strong)" }}>{message}</p>
    </main>
  );
}
