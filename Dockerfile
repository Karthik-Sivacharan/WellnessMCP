# WellnessMCP — Production Dockerfile
#
# Multi-stage build for the MCP server + HTTP ingest endpoint.
# Uses a persistent volume mounted at /data for SQLite storage.
#
# Build: docker build -t wellness-mcp .
# Run:   docker run -p 3456:3456 -v wellness-data:/data wellness-mcp

# --- Stage 1: Build ---
FROM node:20-slim AS builder

WORKDIR /app

# Install build dependencies for native modules (better-sqlite3)
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

# Copy package files and install dependencies
COPY package.json package-lock.json ./
RUN npm ci

# Copy source and compile TypeScript
COPY tsconfig.json ./
COPY src/ ./src/
COPY config/ ./config/
RUN npm run build

# --- Stage 2: Production ---
FROM node:20-slim

WORKDIR /app

# Install runtime dependencies for better-sqlite3
RUN apt-get update && apt-get install -y libsqlite3-0 && rm -rf /var/lib/apt/lists/*

# Copy compiled output and production dependencies
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
COPY --from=builder /app/config ./config

# Create data directory for SQLite persistent volume.
# On Railway, mount a volume at /data to persist the database across deploys.
# Also symlink ~/.wellness-mcp to /data so the keyfile (encryption key fallback)
# persists alongside the database.
RUN mkdir -p /data && \
    mkdir -p /root/.wellness-mcp && \
    ln -sf /data /root/.wellness-mcp

# Environment defaults — override these in Railway's dashboard
ENV DB_PATH=/data/data.db
ENV WELLNESS_MCP_INGEST_PORT=3456
ENV NODE_ENV=production
# Ingest-only mode: skip MCP stdio server since there's no Claude client
# attached in a remote deployment. Only the HTTP ingest endpoint runs.
ENV INGEST_ONLY=true
# HOME must be set for the keyfile fallback path resolution
ENV HOME=/root

# The ingest server listens on this port
EXPOSE 3456

# Start the MCP server (also starts the ingest HTTP server automatically)
CMD ["node", "dist/index.js"]
