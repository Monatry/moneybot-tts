import type { NextConfig } from "next";

/**
 * `basePath` is what lets the app be served from a subpath (/moneytts on
 * example.com) without the reverse proxy having to rewrite anything — nginx
 * passes the prefix through untouched and Next owns it. It is read from the environment
 * rather than hardcoded so `npm run dev` keeps running at the root: a prefixed dev server
 * would need its own Twitch OAuth redirect-URL registration, since Twitch compares
 * `redirect_uri` as a raw string.
 *
 * It is baked in at build time, not read at runtime, which is why the Dockerfile passes it
 * as a build arg. `NEXT_PUBLIC_` is deliberate — lib/basePath.ts reads the same variable in
 * browser code to prefix the URLs `basePath` does not reach (bare fetches, hand-built
 * absolute URLs).
 */
const basePath = process.env.NEXT_PUBLIC_BASE_PATH?.replace(/\/$/, "") || "";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  basePath,
  // Ships a self-contained server plus a pruned node_modules, so the runtime image does not
  // need the dependency tree or a package install. See the Dockerfile's runner stage.
  output: "standalone",
  // The design handoff folder is reference material, not source. Keeping it inside the
  // project root is convenient, but it must never be type-checked or bundled.
  outputFileTracingExcludes: {
    "*": ["./design_handoff_moneybot_tts/**/*"],
  },
};

export default nextConfig;
