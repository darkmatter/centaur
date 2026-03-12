FROM node:22-slim AS base

RUN corepack enable pnpm

WORKDIR /app

# Copy workspace root config + shared packages + this service
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* ./
COPY packages/ packages/
COPY services/web/package.json services/web/
COPY services/web/patches/ services/web/patches/
RUN cd services/web && pnpm install --frozen-lockfile 2>/dev/null || pnpm install

# Copy source and build
FROM base AS builder
COPY services/web/ services/web/
RUN cd services/web && pnpm build

# Production
FROM node:22-slim AS runner
RUN apt-get update && apt-get install -y --no-install-recommends curl jq && rm -rf /var/lib/apt/lists/*
WORKDIR /app

ENV NODE_ENV=production

# Next.js standalone output includes everything needed
COPY --from=builder /app/services/web/.next/standalone ./
COPY --from=builder /app/services/web/.next/static ./services/web/.next/static
COPY scripts/bootstrap-secrets.sh /app/bootstrap-secrets.sh
COPY services/web/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh /app/bootstrap-secrets.sh

EXPOSE 3001
ENV PORT=3001
ENV HOSTNAME="0.0.0.0"

ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["node", "services/web/server.js"]
