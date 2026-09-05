FROM node:20-bookworm-slim

# Build tools for the native better-sqlite3 module.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first (better layer caching). Use the lockfile for reproducibility.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# App source
COPY . .

RUN mkdir -p /app/storage/firmware

# HTTP (dashboard + device API) and MQTT broker
EXPOSE 3456 1883

ENV NODE_ENV=production \
    PORT=3456 \
    OTA_STORAGE_PATH=/app/storage/firmware

CMD ["node", "src/standalone/index.js"]
