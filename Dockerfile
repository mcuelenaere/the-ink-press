FROM oven/bun:1 AS builder

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .
RUN bun run compile

FROM gcr.io/distroless/cc-debian12

WORKDIR /app

COPY --from=builder /app/dist/the-ink-press .

ENTRYPOINT ["./the-ink-press"]
