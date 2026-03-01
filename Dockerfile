FROM node:20-alpine

# Install build dependencies for better-sqlite3
RUN apk add --no-cache python3 make g++ iputils

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy source
COPY tsconfig.json ./
COPY src ./src

# Build
RUN npm run build

# Create data directory for SQLite
RUN mkdir -p /data

# Use /data for persistent storage
ENV DB_PATH=/data/power-monitor.db

VOLUME ["/data"]

CMD ["node", "build/index.js"]
