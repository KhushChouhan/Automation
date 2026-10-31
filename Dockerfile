# Multi-stage Dockerfile for Instagram Reels Automation Monorepo
FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@11.25.0 --activate
WORKDIR /app

# Dependencies stage
FROM base AS dependencies
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY prisma ./prisma/
COPY packages ./packages/
COPY apps ./apps/
RUN pnpm install --frozen-lockfile

# Build stage
FROM dependencies AS builder
RUN pnpm db:generate
RUN pnpm build

# Target: API Service
FROM base AS api
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/apps/api ./apps/api
EXPOSE 8000
CMD ["node", "apps/api/dist/main.js"]

# Target: Worker Service
FROM base AS worker
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/apps/worker ./apps/worker
CMD ["node", "apps/worker/dist/main.js"]

# Target: Admin Dashboard
FROM base AS admin
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/apps/admin ./apps/admin
EXPOSE 3000
CMD ["pnpm", "--filter", "@gcs/admin", "start"]

# Target: Unified Free Service (Fastify API + Background Worker in 1 Free Container)
FROM base AS unified
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/apps/api ./apps/api
COPY --from=builder /app/apps/worker ./apps/worker
COPY --from=builder /app/prisma ./prisma
COPY scripts ./scripts
EXPOSE 8000
CMD ["node", "scripts/start.mjs"]

