FROM node:24-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM node:24-alpine

WORKDIR /app

# Install Sharp with platform-specific native binaries for Alpine/musl
RUN npm install --omit=dev sharp

COPY --from=builder /app/dist .

ENTRYPOINT ["node", "index.js"]
