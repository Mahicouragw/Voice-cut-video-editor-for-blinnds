FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app/server
COPY server/package*.json ./
RUN npm ci --omit=dev
COPY server/server.js server/providers.js ./
COPY web/captions.js /app/web/captions.js
USER node
ENV PORT=3001
EXPOSE 3001
CMD ["node", "server.js"]
