# One image, one explicitly selected process. No Redis server is installed here.
FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@11.25.0 --activate
WORKDIR /app

FROM base AS dependencies
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY prisma ./prisma/
COPY packages ./packages/
COPY apps ./apps/
RUN pnpm install --frozen-lockfile

FROM dependencies AS builder
RUN pnpm db:generate
RUN pnpm build

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=builder /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/apps ./apps
COPY --from=builder /app/prisma ./prisma
COPY scripts ./scripts
EXPOSE 8000
CMD ["node", "scripts/start.mjs"]

FROM runtime AS api
ENV PROCESS_ROLE=api

FROM runtime AS worker
ENV PROCESS_ROLE=worker

FROM runtime AS admin
EXPOSE 3000
CMD ["pnpm", "--filter", "@gcs/admin", "start"]

# Default target is API; worker uses the same image with PROCESS_ROLE=worker.
FROM api AS production
