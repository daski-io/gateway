# syntax=docker/dockerfile:1
FROM node:20-slim AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY scripts/preload-embedding-model.mjs ./scripts/preload-embedding-model.mjs
RUN npm run build
RUN node scripts/preload-embedding-model.mjs

RUN npm prune --omit=dev

FROM node:20-slim AS runtime
WORKDIR /app

COPY package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "dist/index.js"]
