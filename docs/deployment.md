# Deployment and recovery

## Topology and reliability

Run the API, BullMQ worker, and Next.js admin as separate processes. PostgreSQL is authoritative. API and worker must share exactly one managed PostgreSQL URL and one managed Redis URL. Use Redis 7 or 8 (BullMQ documents Redis 6.2+ compatibility), persistence, and `maxmemory-policy noeviction`. Provider-compatible Redis must support BullMQ's blocking connections and Lua scripts; a REST-only Redis endpoint is unsuitable.

The previous free Render service combined API, worker, embedded ephemeral Redis, and schema pushes. That setup cannot guarantee scheduled execution: Render free web services sleep after 15 minutes without inbound traffic; filesystem data is ephemeral and free PostgreSQL expires after 30 days. A successful HTTP health response proves neither continuous worker operation nor delivery at 19:00/20:00 IST. The replacement `render.yaml` provisions billable, always-on API and worker services with managed PostgreSQL and Key Value. Review provider plans before applying it. Changing repository files does not migrate or repair an existing live service automatically.

Sources: [Render free limitations](https://render.com/docs/free), [Render Blueprint reference](https://render.com/docs/blueprint-spec), [BullMQ Redis compatibility](https://docs.bullmq.io/guide/redis-tm-compatibility/).

## Render

Both processes use the same Docker image with explicit commands `node scripts/start.mjs api` and `node scripts/start.mjs worker`. Neither starts Redis. The shared `reels-runtime` environment group contains default-off automation and publishing gates and the generated private `ADMIN_API_TOKEN`. Provider secrets and source folder/Sheet IDs belong in that secret group only after their integrations are authorized; the checked-in Blueprint does not embed account resource IDs.

The API and worker pre-deploy hooks run only `prisma migrate deploy` through `node scripts/start.mjs migrate`. Failed migration exits nonzero and blocks that deployment. Prisma serializes migration application with its advisory lock; serialize API then worker releases to avoid lock timeout during simultaneous deployments. Keep existing infrastructure URLs during adoption: do not accidentally point a new service at an empty replacement database or separate queue. A database created using `db push` may require an explicitly reviewed Prisma baseline before migrations can be applied. Never mark migrations applied without first comparing actual schema and constraints.

Deploy the same immutable revision to both services. Render supplies `RENDER_GIT_COMMIT`; Railway supplies `RAILWAY_GIT_COMMIT_SHA`; `APP_REVISION` can override either with an immutable release SHA. Revision values are restricted to non-secret tokens in health evidence. Check the API revision and worker heartbeat revision match after release.

## Railway and Docker Compose

Create two Railway services from the repository using `railway.json`. Set `PROCESS_ROLE=api` for one and `PROCESS_ROLE=worker` for the other; the default is API. Both receive the same managed data URLs and default-off gates. The pre-deploy command runs migrations and fails the release on error. Configure HTTP `/health` only for the API; worker health uses the heartbeat below. Railway retry policy is bounded; configure alerts for exhausted restarts.

`docker compose -f docker-compose.prod.yml up --build` uses only externally provisioned managed PostgreSQL/Redis; it deliberately creates no datastore containers. Set the explicit managed URLs and server-only auth secrets in ignored `.env`. The migrate service must complete successfully before API/worker start. Loopback Redis is refused in production. Local development uses `docker-compose.yml` instead, with Redis 7 published at `127.0.0.1:6380`, avoiding the unrelated legacy Redis service on 6379. Choose one local Redis and point every app at that same endpoint.

## Vercel admin environment

Use `apps/admin` as the Next.js project in the monorepo and install/build with the workspace lockfile. Set the following in the Vercel server environment for each intended deployment environment:

| Variable             | Required value                                                                   |
| -------------------- | -------------------------------------------------------------------------------- |
| `API_BASE_URL`       | HTTPS base URL of the deployed API, without `/api/v1`; never localhost in Vercel |
| `ADMIN_API_TOKEN`    | Same high-entropy token used by the API; server-only                             |
| `DASHBOARD_USERNAME` | Browser Basic Auth username (defaults to `admin`)                                |
| `DASHBOARD_PASSWORD` | Independent strong browser password; missing password blocks dashboard access    |

Do not prefix any secret with `NEXT_PUBLIC_`. Browser requests go through the authenticated Next.js server routes; never embed the API token in browser code or pass it as a URL query. `ADMIN_API_TOKEN` and the dashboard password protect different boundaries. Basic Auth is a deployment access gate; it does not implement per-user roles, account revocation, or a complete identity provider. Keep HTTPS enabled. A Vercel preview needs its own approved API target and environment values; it must not silently acquire production write access.

## Health and restart checks

- `/health`: process liveness plus source revision, safe for platform probes.
- `/readiness`: PostgreSQL and Redis connectivity only, HTTP 503 when dependencies fail. It makes no Google or Meta request.
- Authenticated `/api/v1/queues/status`: queue delivery state. Connectivity/counts alone do not prove a live worker or provider success.
- Authenticated `/api/v1/operations`: API revision, dependency readiness, and worker heartbeat freshness. The worker writes `gcs:worker:heartbeat` only after startup with `{revision,startedAt,observedAt,queues}` every 15 seconds, with Redis TTL 60 seconds. Stopped/paused/disconnected worker evidence expires. This evidence is not a successful-job or external-provider assertion. One shared heartbeat represents at least one worker; it does not inventory multiple replicas.

A supervised process failure exits the container so the platform can restart it. Signals are forwarded to the runtime for graceful worker shutdown. PostgreSQL outbox records remain authoritative after a queue outage; retry dispatch only through the normal idempotent worker path. Never recover by clearing publishing attempts, deleting queue state, changing scheduled timestamps, or resolving sync conflicts at startup.

Before enabling a release, rehearse in a disposable environment with fake external adapters: stop worker, observe stale heartbeat; restore worker, observe a new startedAt and matching revision; interrupt Redis, observe readiness failure then recovery; leave an outbox record pending, restart worker, confirm one deterministic delivery; repeat process restart and confirm no duplicate schedule/content/publication. Verify missed/past slots remain visible and are not published late by bypassing the time guard. Do not run this rehearsal against production data.

## Migration and acceptance limits

Validate schema syntax without connecting using `pnpm exec prisma validate --schema prisma/schema.prisma` with a disposable placeholder `DATABASE_URL`. Inspect migration SQL and test migrations against a newly created disposable PostgreSQL database, then an approved copy of the prior schema/data. `migrate deploy` applies reviewed SQL; it does not detect every drift condition, restore data, or establish backup quality. Back up and rehearse restore before adopting production changes. Never use `db push`, `migrate reset`, or destructive integration tests against unknown `.env`/production URLs.

Automated fake tests verify launcher failure propagation, queue-isolation prevention, process separation, heartbeat reconnect behavior, and safe deployment defaults. A real Docker build, migrated PostgreSQL acceptance, Redis restart persistence and provider deployment verification remain separate checks requiring those services. No real external write or Meta publish belongs in automated QA.
