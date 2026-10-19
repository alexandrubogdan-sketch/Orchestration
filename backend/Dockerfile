FROM node:22-slim AS base
WORKDIR /app
COPY package.json package-lock.json* ./

FROM base AS dev
ENV NODE_ENV=development
RUN npm install
COPY . .
CMD ["npm", "run", "dev:api"]

FROM base AS build
ENV NODE_ENV=production
RUN npm ci --legacy-peer-deps --include=dev
COPY . .
RUN npm run build

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm ci --legacy-peer-deps --include=dev
COPY --from=build /app/dist ./dist
COPY --from=build /app/db ./db
USER node
CMD ["sh", "-c", "npm run migrate:up && node dist/src/api/server.js"]
