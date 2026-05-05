# syntax=docker/dockerfile:1
FROM node:20-slim AS builder
WORKDIR /app

# better-sqlite3 compiles native bindings against Node's ABI during install.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN npm install --no-audit --no-fund

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

RUN npm prune --omit=dev

FROM node:20-slim AS runtime
WORKDIR /app

# Writable dir for the SQLite DB; Railway volume is mounted here in production.
RUN mkdir -p /app/data

COPY package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "dist/index.js"]
