FROM oven/bun:1 AS builder

WORKDIR /app

COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile

COPY . .
RUN bun run build

FROM oven/bun:1-slim

WORKDIR /app

# Copy built output and node_modules (needed for sharp native binaries)
COPY --from=builder /app/dist .
COPY --from=builder /app/node_modules ./node_modules

ENTRYPOINT ["bun", "index.js"]
