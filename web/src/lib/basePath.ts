/**
 * The prefix the app is mounted under, e.g. "/moneytts" in the deployed stack and "" in dev.
 *
 * Next's `basePath` (next.config.ts) already rewrites `next/link`, the router and every
 * static asset URL. What it does *not* touch is anything that builds a URL by hand:
 *
 *   - bare `fetch("/api/…")` from client code
 *   - `window.location.origin + "/…"`
 *   - `window.location.replace("/…")`
 *
 * Those are the four sites in this app that must go through `withBasePath`. Adding an API
 * route and fetching it with a bare absolute path is the one mistake that silently 404s only
 * once deployed, because dev runs with an empty prefix.
 *
 * The value is read from an env var rather than hardcoded so `npm run dev` stays at the
 * root — a prefixed dev server would also mean a second Twitch redirect URL registration,
 * since Twitch compares `redirect_uri` as a raw string. `NEXT_PUBLIC_` means Next inlines it
 * at build time, so this works identically in browser and server code, and the deployed
 * value is baked into the image by the Dockerfile's build arg.
 */
const RAW = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

/** Normalised: leading slash, no trailing slash, or "" when mounted at the root. */
export const BASE_PATH = RAW === "/" ? "" : RAW.replace(/\/$/, "");

/** Prefixes an app-absolute path. `withBasePath("/avatar")` → "/moneytts/avatar". */
export function withBasePath(path: string): string {
  if (!path.startsWith("/")) return path;
  return `${BASE_PATH}${path}`;
}

/** The app's own origin *including* the prefix — the base every external redirect uses. */
export function appOrigin(): string {
  return `${window.location.origin}${BASE_PATH}`;
}

/**
 * The overlay URL to paste into an OBS browser source: `appOrigin() + "/avatar"`, except that
 * a leading `private.` is dropped from the host.
 *
 * In the deployed pair the `private.` host is the gated one, and a browser source is a bare
 * CEF with no way through a login — so a streamer copying what their own address bar says
 * hands OBS a sign-in page instead of the avatar. The public host serves the same `/avatar`
 * route, and the overlay paints only what the bridge pushes it, so which engine that build
 * synthesises with is nothing to it.
 *
 * A host with no such prefix is returned untouched, which covers dev and any single-host
 * deployment.
 */
export function obsOverlayUrl(): string {
  const { protocol, host } = window.location;
  return `${protocol}//${host.replace(/^private\./, "")}${BASE_PATH}/avatar`;
}
