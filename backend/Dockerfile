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
#
# --include=dev: npm treats a NODE_ENV=production env var (set above) as an
# implicit --omit=dev on `npm ci`/`npm install`, even without the flag. That
# silently dropped `typescript` here, breaking `tsc` in the next step
# ("tsc: not found") the first time this stage was ever actually built.
RUN npm ci --legacy-peer-deps --include=dev
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
# --include=dev overrides the NODE_ENV=production-implied --omit=dev above —
# see the matching comment in the `build` stage for why that flag is needed.
RUN npm ci --legacy-peer-deps --include=dev
COPY --from=build /app/dist ./dist
COPY --from=build /app/db ./db
USER node
# tsconfig.json's rootDir is "." (not "src"), so tsc preserves the src/
# prefix on emit: the compiled entry point is dist/src/api/server.js, not
# dist/api/server.js. This only ever surfaced once this image was actually
# run (Railway), since local dev/tests run via tsx against the .ts sources
# directly and never exercised this exact compiled path.
CMD ["node", "dist/src/api/server.js"]

