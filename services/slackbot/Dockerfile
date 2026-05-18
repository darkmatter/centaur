FROM oven/bun:1.3.13-slim

WORKDIR /app
ENV NODE_ENV=production

COPY services/slackbot/package.json services/slackbot/bun.lock ./
RUN bun install --frozen-lockfile

COPY services/slackbot/ ./

EXPOSE 3001
ENV PORT=3001
CMD ["bun", "src/index.ts"]
