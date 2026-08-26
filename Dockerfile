# Node 22 LTS + FFmpeg/FFprobe + standalone yt-dlp
FROM node:22-bookworm-slim

ENV NODE_ENV=production
ENV PORT=3000
ENV CLIPPER_DATA_DIR=/data/database
ENV CLIPPER_STORAGE_DIR=/data/storage
ENV CLIPPER_LOG_DIR=/data/logs
ENV CLIPPER_YTDLP_PATH=/usr/local/bin/yt-dlp
ENV CLIPPER_YTDLP_POT_ENABLED=1
ENV YTDLP_POT_PROVIDER_URL=http://127.0.0.1:4416

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl git \
    && curl -L --fail --retry 3 -o /usr/local/bin/yt-dlp https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux \
    && chmod +x /usr/local/bin/yt-dlp \
    && /usr/local/bin/yt-dlp --version \
    && git clone --depth 1 --branch 1.3.1 https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git /opt/bgutil \
    && cd /opt/bgutil/server \
    && npm ci --no-audit --no-fund \
    && npm install --no-save typescript \
    && ./node_modules/.bin/tsc \
    && mkdir -p /root/yt-dlp-plugins/bgutil-ytdlp-pot-provider \
    && cp -r /opt/bgutil/plugin/. /root/yt-dlp-plugins/bgutil-ytdlp-pot-provider/ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY . .

RUN mkdir -p /data/database /data/storage /data/logs

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/health').then((response) => { if (!response.ok) process.exit(1); }).catch(() => process.exit(1))"

CMD ["sh", "-c", "node /opt/bgutil/server/build/main.js >/tmp/bgutil-provider.log 2>&1 & exec npm start"]




