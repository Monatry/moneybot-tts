# syntax=docker/dockerfile:1

# Moneybot TTS — Next.js 15 / React 19, built and run entirely in the image. The host's own
# node is v10 and cannot build this, so `docker compose up -d --build` is the only way to
# produce a working bundle here.

# ── deps ────────────────────────────────────────────────────────────────────────────────
# Split from the build so a source-only change reuses the installed tree.
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ── builder ─────────────────────────────────────────────────────────────────────────────
FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# The mount prefix, baked in at build time — Next resolves `basePath` when it compiles, and
# lib/basePath.ts reads the same variable to prefix the URLs basePath does not reach. It is
# NOT a runtime setting: changing it means rebuilding.
ARG NEXT_PUBLIC_BASE_PATH=""
ENV NEXT_PUBLIC_BASE_PATH=$NEXT_PUBLIC_BASE_PATH

# The Twitch application to sign in as. Public by design (implicit flow, no secret), needed by
# browser code, and therefore inlined into the bundle at build time as well — same rule: a new
# value means a rebuild. No default here either; compose supplies it from .env.
ARG NEXT_PUBLIC_TWITCH_CLIENT_ID=""
ENV NEXT_PUBLIC_TWITCH_CLIENT_ID=$NEXT_PUBLIC_TWITCH_CLIENT_ID

ENV NEXT_TELEMETRY_DISABLED=1
# This stage needs outbound network: next/font/google downloads Caprasimo and Figtree and
# self-hosts them, and the build fails rather than falling back if it cannot reach Google.
RUN npm run build

# ── runner ──────────────────────────────────────────────────────────────────────────────
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Nothing here is written at runtime — settings, avatars and the token all live in the
# streamer's browser, and the only server work is proxying the TTS stream. So the app can
# run as the image's own unprivileged user with no writable mounts at all.
RUN addgroup -g 1001 -S nodejs && adduser -u 1001 -S nextjs -G nodejs

# `output: "standalone"` emits server.js plus only the node_modules it actually traced.
# .next/static is not part of that bundle and has to be copied alongside it.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs
EXPOSE 3000

CMD ["node", "server.js"]
