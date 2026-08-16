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
  outputFileTracingExcludes: {
    "*": [
      // The design handoff folder is reference material, not source. Keeping it inside the
      // project root is convenient, but it must never be type-checked or bundled.
      "./design_handoff_moneybot_tts/**/*",
      // The browser engine's dependency tree, which exists only to be bundled into the
      // worker chunk under .next/static and shipped to the browser. Nothing server-side
      // imports any of it. Left in, the tracer follows kokoro-js → @huggingface/transformers
      // → onnxruntime-node and copies a few hundred megabytes of native CPU/GPU binaries —
      // for an architecture nothing in this image runs — into the standalone output.
      "./node_modules/onnxruntime-node/**/*",
      "./node_modules/sharp/**/*",
    ],
  },
  webpack: (config) => {
    // Same story one layer down: @huggingface/transformers resolves to its prebuilt *web*
    // bundle in every compilation here (its "node" export condition is only picked for a
    // Node target), but its package graph still names the Node runtime and sharp. Aliasing
    // them away means a stray import cannot drag either into a bundle — and turns what
    // would be a confusing "module not found: onnxruntime-node" at build time into nothing
    // at all.
    config.resolve.alias = {
      ...config.resolve.alias,
      "onnxruntime-node$": false,
      sharp$: false,
    };
    return config;
  },
};

export default nextConfig;
