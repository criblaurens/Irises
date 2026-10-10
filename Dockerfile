# ── Server build stage (TypeScript → dist/) ──
FROM node:24-slim AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install ALL dependencies (including dev for tsc)
RUN npm ci

# Copy source and build (tsc + cpx copies persona Context.md + *.txt into dist)
COPY . .
RUN npm run build

# ── Web debug client build stage (Next.js static export → web/out/) ──
FROM node:24-slim AS web-builder

WORKDIR /app/web

COPY web/package*.json ./
RUN npm ci

COPY web/ ./
RUN npm run build

# ── Production stage ──
FROM node:24-slim

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install only production dependencies
RUN npm ci --omit=dev

# Copy the built server
COPY --from=builder /app/dist ./dist

# Copy the static web debug client (served by the server at `/`)
COPY --from=web-builder /app/web/out ./web/out

# Expose port (matches PORT=8080 in the VM .env / Caddy reverse_proxy target)
EXPOSE 8080

# The image does not carry deploy/app.env (where PORT=8080 is set for a local clone), and
# src/index.ts falls back to 3000 — so without this line a bare `docker run -p 8080:8080` reaches
# nothing while the Dockerfile advertises 8080. Compose masks it by passing app.env as env_file.
ENV PORT=8080

# Local state (SQLite + memory-tier markdown) lives here — compose mounts a named
# volume over it. Created + chowned BEFORE dropping to the node user so the volume
# inherits writable ownership on first mount.
ENV IRISES_HOME=/data
RUN mkdir -p /data && chown node:node /data

# Run as the image's built-in non-root user
USER node

# Start the server
CMD ["node", "dist/index.js"]
