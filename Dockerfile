# syntax=docker/dockerfile:1
FROM node:22-slim AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY skills ./skills
COPY scripts ./scripts
RUN npm run build

RUN npm prune --omit=dev

FROM node:22-slim AS runtime
WORKDIR /app

COPY package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

ARG SOURCE_SHA
ENV RELEASE_SOURCE_SHA=$SOURCE_SHA
ENV NODE_ENV=production
EXPOSE 3000
USER node
CMD ["node", "dist/index.js"]
