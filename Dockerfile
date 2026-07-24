# syntax=docker/dockerfile:1.7
# Multi-stage Dockerfile per v2 doc, Pilar 9.
#
# Stage layout:
#   1. deps     — restore production + dev deps using pnpm with the
#                 frozen lockfile. Cached so subsequent builds skip
#                 reinstall when package.json / lockfile are unchanged.
#   2. build    — compile TypeScript via `nest build`, then prune to
#                 production-only deps so the runtime image stays lean.
#   3. runtime  — distroless Node 22 image, non-root, only the dist
#                 output and pruned node_modules. No shell, no
#                 package manager, no build toolchain.

ARG NODE_VERSION=22
ARG PNPM_VERSION=10.33.4

# ---------- Stage 1: deps (full install, with native builds) ----------
FROM node:${NODE_VERSION}-bookworm-slim AS deps
WORKDIR /app

ARG PNPM_VERSION
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate

# argon2 is the only native binding today; bookworm-slim has the
# tooling already, so we do not add build-essential.
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store && \
    pnpm install --frozen-lockfile

# ---------- Stage 2: build (compile + prune dev deps) ----------
FROM node:${NODE_VERSION}-bookworm-slim AS build
WORKDIR /app

ARG PNPM_VERSION
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate

COPY --from=deps /app/node_modules ./node_modules
COPY . .

RUN pnpm run build

# Drop dev dependencies so the runtime image only carries what the
# server needs at runtime.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store && \
    pnpm prune --prod

# ---------- Stage 3: runtime (distroless, non-root) ----------
FROM gcr.io/distroless/nodejs${NODE_VERSION}-debian12 AS runtime
WORKDIR /app

ENV NODE_ENV=production
# TIME-1 layer 1: the business (WIB / Asia/Jakarta, UTC+7, no DST) is the
# process clock, not UTC — without this, `new Date()` and BullMQ's cron
# scheduler (when a job omits an explicit `tz`, see scheduler.constants.ts)
# both silently run on the container's UTC clock. Node reads zoneinfo from
# `/usr/share/zoneinfo`; verified present in this exact base image
# (gcr.io/distroless/nodejs22-debian12) by running it with
# `-e TZ=Asia/Jakarta` and checking `Intl.DateTimeFormat().resolvedOptions().
# timeZone`. The `COPY --from=build /usr/share/zoneinfo` below is belt-and-
# suspenders insurance on top of that: if a future base-image bump ever
# drops zoneinfo, Node does NOT throw for an unresolvable TZ — it silently
# falls back to UTC, exactly the bug this fixes, and neither
# `drizzle.service.timezone.int-spec.ts` nor `wib-date.spec.ts` would catch
# that regression (both are deliberately TZ-independent — see wib-date.ts).
# The `build` stage (node:22-bookworm-slim) already carries `tzdata`, so
# this COPY is free (no extra install).
ENV TZ=Asia/Jakarta

COPY --from=build /usr/share/zoneinfo /usr/share/zoneinfo
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/drizzle ./drizzle
COPY --from=build /app/package.json ./package.json

# Non-root by default in distroless (UID 65532).
USER nonroot
EXPOSE 3000

# Default entrypoint is the HTTP API. The worker process runs from the
# same image with a different command — set when deploying:
#
#   docker run isp-cms-be:<sha>                  # API
#   docker run isp-cms-be:<sha> dist/worker.js   # worker
#
# Distroless's nodejs entrypoint is `node`, so passing a different JS
# path as the command is sufficient. K8s deploys this as two
# Deployments sharing the image but overriding `command` per workload.
CMD ["dist/main.js"]
