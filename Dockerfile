# ── Stage 1: build ──────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json ./
RUN npm install --ignore-scripts

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build


# ── Stage 2: production ──────────────────────────────────────────────────────
FROM node:22-alpine

WORKDIR /app

# Install only production dependencies
COPY package.json ./
RUN npm install --omit=dev --ignore-scripts

# Copy compiled output from builder
COPY --from=builder /app/dist ./dist

# Data directory (mount a volume here on Railway)
RUN mkdir -p /data

EXPOSE 3000

ENV NODE_ENV=production
ENV MCP_DATA_DIR=/data

CMD ["node", "dist/index.js"]
