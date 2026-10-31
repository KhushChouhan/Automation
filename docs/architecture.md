# Runtime architecture

The project is a pnpm TypeScript monorepo organized as a modular monolith. `@gcs/core` contains framework-independent rules; `@gcs/database` owns Prisma access and repositories; the API and worker are separate processes; and the Next.js admin is a read-only operations view. PostgreSQL is authoritative for workflow records. Redis/BullMQ provides durable job delivery, not business state.

## Milestone-one operational path

```text
Next.js admin --server fetch--> Fastify API --> Prisma --> PostgreSQL
                                         \--> ioredis ping --> Redis
Worker -----------------------------------------------> PostgreSQL / Redis
```

The admin obtains counts, automation state, and today's schedule from `GET /api/v1/dashboard`. The API derives the business date in the configured `TIMEZONE`, joins scheduled videos to their face and workflow/approval states, and includes explicit open cards for the two agreed slots. It performs read-only queries. The persisted `automation.enabled` setting is authoritative for the dashboard indicator and defaults to off when absent.

`GET /health` is process liveness and does not depend on backing services. `GET /readiness` checks a PostgreSQL query and Redis PING and returns `503` when either is unavailable. Responses are not cacheable and the API adds standard security headers.

## Local services and exposure

Compose provisions PostgreSQL 16 and Redis 7 with persistent named volumes and health checks. Host ports bind to `127.0.0.1`; the API also listens on loopback by default. The admin API base URL is server-side configuration and is not embedded in client-side JavaScript.

The admin and API are not authenticated yet. They are local-only milestone-one operations tools. Before deployment, add server-side sessions, role authorization, origin/CSRF protections for future mutations, and a trusted network/reverse proxy configuration. No write endpoints or external publishing calls are part of this slice.
