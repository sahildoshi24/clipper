# Node 22 LTS with FFmpeg and FFprobe for local-video clipping.
FROM node:22-bookworm-slim

ENV NODE_ENV=production
ENV PORT=3000
ENV CLIPPER_DATA_DIR=/data/database
ENV CLIPPER_STORAGE_DIR=/data/storage
ENV CLIPPER_LOG_DIR=/data/logs

WORKDIR /app

# The Debian ffmpeg package supplies both ffmpeg and ffprobe.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY . .

RUN mkdir -p /data/database /data/storage /data/logs

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/health').then((response) => { if (!response.ok) process.exit(1); }).catch(() => process.exit(1))"

CMD ["npm", "start"]
