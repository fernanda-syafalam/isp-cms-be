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
