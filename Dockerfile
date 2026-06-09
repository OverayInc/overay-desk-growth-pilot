# Debian slim (NOT alpine — Playwright/Chromium needs glibc + apt deps).
FROM node:24-bookworm-slim

WORKDIR /app

# Install runtime deps (playwright) reproducibly from the lockfile.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Install Chromium + its OS libraries. Reddit's API is gone (2026) so post stats
# come from a real headless browser; this also powers discovery email rendering
# (DISCOVERY_USE_RENDERER) for JS-rendered contact pages. Adds ~500MB.
# `apt-get update` first: the base image's package index can be stale and make
# playwright's apt install fetch a version the mirror has already moved (400).
RUN apt-get update \
    && npx playwright install --with-deps chromium \
    && rm -rf /var/lib/apt/lists/*

COPY src ./src
COPY public ./public
COPY data ./data
COPY docs ./docs

# The docker-compose bind mount (./data:/app/data) shadows the committed Reddit
# session above. Keep an UN-shadowed copy at /app/seed so the server can restore
# it into an empty/bind-mounted volume on boot (ensureRedditSessionSeeded()).
RUN mkdir -p /app/seed \
    && cp -f data/reddit-state.json data/reddit-session-meta.json /app/seed/ 2>/dev/null || true

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=4173
ENV DATA_FILE=/app/data/app-data.json

EXPOSE 4173

CMD ["node", "src/server.mjs"]
