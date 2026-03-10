FROM node:22-slim AS base

RUN corepack enable pnpm

WORKDIR /app

# Install dependencies (cached independently of source changes)
COPY package.json pnpm-lock.yaml* ./
COPY patches/ patches/
RUN pnpm install --frozen-lockfile 2>/dev/null || pnpm install

# Copy source and build
FROM base AS builder
COPY . .
RUN pnpm build

# Production
FROM node:22-slim AS runner
RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*
WORKDIR /app

ENV NODE_ENV=production

# Next.js standalone output includes everything needed
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY entrypoint.sh ./entrypoint.sh

EXPOSE 3001
ENV PORT=3001
ENV HOSTNAME="0.0.0.0"

CMD ["./entrypoint.sh"]
