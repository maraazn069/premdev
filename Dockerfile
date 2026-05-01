# ===== Build stage =====
FROM node:20-bookworm-slim AS builder
WORKDIR /build

# Build deps for native modules (better-sqlite3)
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates git && \
    rm -rf /var/lib/apt/lists/*

# Root + workspaces
COPY package.json package-lock.json* ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN cd apps/api && npm install --no-audit --no-fund && \
    cd ../web && npm install --no-audit --no-fund

# Source
COPY apps/api ./apps/api
COPY apps/web ./apps/web

# Build web
RUN cd apps/web && npm run build

# Build API (TypeScript -> JS)
RUN cd apps/api && npm run build

# Add node-pty for production (compiled with build deps still present)
RUN cd apps/api && npm install --no-audit --no-fund node-pty

# ===== Runtime stage =====
FROM node:20-bookworm-slim
WORKDIR /app

# Runtime libs needed for native modules + docker CLI for container ops
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl wget tini docker.io git && \
    rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PORT=3001 \
    HOST=0.0.0.0

# Copy built API + production node_modules
COPY --from=builder /build/apps/api/dist                ./apps/api/dist
COPY --from=builder /build/apps/api/node_modules        ./apps/api/node_modules
COPY --from=builder /build/apps/api/package.json        ./apps/api/package.json

# Copy built frontend (served by API)
COPY --from=builder /build/apps/web/dist ./apps/web/dist

WORKDIR /app/apps/api
EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -q -O - http://localhost:3001/api/health || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/index.js"]
