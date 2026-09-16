# syntax=docker/dockerfile:1
# node:22-slim resolves to this bookworm image today; the explicit tag keeps
# the Debian package pin below valid if the alias moves to a newer Debian.
FROM node:22-bookworm-slim AS base
# Debian security update for the PCRE2 library in the Node image. The develop
# image scan (release-image.yml) fails on fixable MEDIUM+ findings.
RUN apt-get update \
 && apt-get install -y --no-install-recommends libpcre2-8-0=10.42-1+deb12u1 \
 && rm -rf /var/lib/apt/lists/*

FROM base AS builder
WORKDIR /app
ARG RAILWAY_GIT_COMMIT_SHA
ARG SOURCE_SHA=$RAILWAY_GIT_COMMIT_SHA
ENV SOURCE_SHA=$SOURCE_SHA

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY scripts ./scripts
COPY Dockerfile railway.json ./
RUN npm run build

RUN npm prune --omit=dev

FROM base AS runtime
WORKDIR /app

COPY package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

# The runtime executes prebuilt JavaScript only (railway.json starts
# `node dist/index.js`). Removing npm/npx drops the package manager's bundled
# dependencies, which carry most of the base image's fixable advisories.
RUN rm -rf /usr/local/lib/node_modules/npm \
 && rm -f /usr/local/bin/npm /usr/local/bin/npx

ARG RAILWAY_GIT_COMMIT_SHA
ARG SOURCE_SHA=$RAILWAY_GIT_COMMIT_SHA
ENV RELEASE_SOURCE_SHA=$SOURCE_SHA
ENV NODE_ENV=production
EXPOSE 3000
USER node
CMD ["node", "dist/index.js"]
