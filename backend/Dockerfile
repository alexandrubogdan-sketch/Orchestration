# Multi-stage Dockerfile. `dev` is what docker-compose.yml uses locally
# (source is bind-mounted, tsx watch does the compiling); `runtime` is the
# production image built by CI, unused until a real deploy pipeline
# exists but kept accurate from Milestone 0 onward.

FROM node:22-slim AS base
WORKDIR /app
COPY package.json package-lock.json* ./

FROM base AS dev
ENV NODE_ENV=development
RUN npm install
COPY . .
# Actual command is set per-service in docker-compose.yml
# (dev:api / dev:worker).
CMD ["npm", "run", "dev:api"]

FROM base AS build
ENV NODE_ENV=production
# --legacy-peer-deps: @hatchet-dev/typescript-sdk's peerOptional range on
# @opentelemetry/exporter-trace-otlp-grpc (^0.218.0) is stricter than what
# @opentelemetry/sdk-node actually resolves to (0.220.0) in this lockfile.
# `npm install` (used locally/in dev) tolerates this; `npm ci` (strict) does
# not, which only surfaced once this Dockerfile was actually built for a
# real deploy (Railway) rather than just `next build`/`tsc` locally.
RUN npm ci --legacy-peer-deps
COPY . .
RUN npm run build

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
# Deliberately NOT --omit=dev: keeps node-pg-migrate (and tsx) in the image
# so `npm run migrate:up` can be run as a one-off exec against the deployed
# container's private-network DATABASE_URL (e.g. via Railway's Console tab)
# without needing a separate migration image. Small size tradeoff, worth it
# for an ops task that only needs to exist at all, not be fast.
RUN npm ci --legacy-peer-deps
COPY --from=build /app/dist ./dist
COPY --from=build /app/db ./db
USER node
CMD ["node", "dist/api/server.js"]
