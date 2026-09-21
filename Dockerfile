FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg curl ca-certificates && rm -rf /var/lib/apt/lists/*
# Pinned DeepFilterNet binary for free, keyless on-server AI noise removal (no Python/Torch needed).
RUN curl -fsSL -o /usr/local/bin/deep_filter https://github.com/Rikorose/DeepFilterNet/releases/download/v0.5.6/deep-filter-0.5.6-x86_64-unknown-linux-musl && chmod +x /usr/local/bin/deep_filter && deep_filter --version
WORKDIR /app/server
COPY server/package*.json ./
RUN npm ci --omit=dev
COPY server/server.js server/providers.js ./
COPY web/captions.js /app/web/captions.js
USER node
ENV PORT=3001
EXPOSE 3001
CMD ["node", "server.js"]
