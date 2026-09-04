FROM node:20-slim

WORKDIR /app

# Copy package files
COPY package.json ./
RUN npm install --production

# Copy source
COPY . .

# Create firmware storage directory
RUN mkdir -p /app/storage/firmware

EXPOSE 3000

ENV NODE_ENV=production
ENV PORT=3000
ENV OTA_STORAGE_PATH=/app/storage/firmware

CMD ["node", "index.js"]
