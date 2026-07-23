# deploy/Dockerfile — production image for the HDV Foundation HOPE gateway.
#
# Build context is the repo root (big5-matrix/). Multi-stage:
#   1) builder — install ALL deps + generate the Prisma client + typecheck (fail fast).
#   2) runtime — slim image with prod deps only, runs the gateway via tsx.
#
# Build (from big5-matrix/):
#   docker build -f deploy/Dockerfile -t hdv-foundation/gateway:latest .
# Or via compose:
#   docker compose -f deploy/docker-compose.prod.yml up -d --build

# ---------- stage 1: build ----------
FROM node:22-bookworm-slim AS builder
WORKDIR /app

# Install deps first for layer caching.
COPY package.json package-lock.json ./
RUN npm ci

# Copy the source and generate the Prisma client + typecheck as a build gate.
COPY . .
RUN npm run db:generate && npm run typecheck

# ---------- stage 2: runtime ----------
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Bring in the built app (node_modules includes tsx + the generated Prisma client).
COPY --from=builder /app ./

# The gateway binds PORT (default 8787). Compose publishes it on loopback only.
ENV PORT=8787
EXPOSE 8787

# Run as the built-in non-root user shipped by the node image.
USER node

# KNOLL gates every routed packet; the gateway never bypasses APEX.
CMD ["npm", "run", "gateway"]
