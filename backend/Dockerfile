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
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY --from=build /app/db ./db
USER node
CMD ["node", "dist/api/server.js"]
