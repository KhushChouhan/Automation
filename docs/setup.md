# Local setup

## Requirements

- Node.js 22 or later
- pnpm 11.25 or later
- Docker Desktop or Docker Engine with Compose

## Start local services

Copy `.env.example` to `.env`, then start the database and queue services:

```powershell
Copy-Item .env.example .env
docker compose up -d
pnpm install
pnpm db:generate
pnpm db:migrate
pnpm db:seed
```

The Compose file binds PostgreSQL and Redis to loopback only. Its development database password is `postgres`; change it with `POSTGRES_PASSWORD` before using the services outside a local development machine.

## Run the dashboard and API

Use separate terminals:

```powershell
pnpm --filter @gcs/api dev
```

```powershell
pnpm --filter @gcs/admin dev
```

```powershell
pnpm --filter @gcs/worker start
```

Open `http://localhost:3000`. The server-rendered admin fetches `API_BASE_URL` (default `http://127.0.0.1:3001`). API liveness and backing-service readiness are `/health` and `/readiness`; Google integration readiness is separate at `/api/v1/integrations/google/status`. Dashboard data is at `/api/v1/dashboard`.

## Google local configuration

Set Google values only in the ignored local `.env` file. The example intentionally leaves credentials and IDs blank. Choose OAuth (`GOOGLE_AUTH_TYPE=oauth`) and set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_REFRESH_TOKEN`, or choose `service_account` and set `GOOGLE_SERVICE_ACCOUNT_JSON`. Provide `GOOGLE_SHEET_ID`, `GOOGLE_VIDEO_FOLDER_ID`, and `GOOGLE_THUMBNAIL_FOLDER_ID`; `GOOGLE_ARCHIVE_FOLDER_ID` is required only when `GOOGLE_DRIVE_ARCHIVE_ENABLED=true`. The status endpoint and dashboard show credential presence and configured resource IDs, never credential values.

`POST /api/v1/sync/google` queues a sync job and does not itself claim Google data was read. The dashboard's **Run Sync** button uses the same local endpoint. Mutation endpoints accept loopback requests only; optionally set `ADMIN_API_TOKEN` to require a bearer token as well. Keep both API and admin bound to loopback and do not expose either to an untrusted network. `GET /api/v1/sync/google/status` reports queue state, and `GET /api/v1/sync/conflicts` lists up to 100 conflict summaries. Resolve an open conflict with `POST /api/v1/sync/conflicts/{id}/resolve`; this marks it resolved and does not alter either source value.

Google readiness does not affect `/readiness`, which reports only PostgreSQL and Redis availability. No Google call is made just to check readiness. Never commit `.env`, credentials, tokens, or service-account JSON; rotate a credential if it is exposed. Production publishing remains disabled.

The seed creates five videos and atomically fills today's 19:00 and 20:00 slots to demonstrate the face-rotation rule.

The admin is intended for local development and has no user accounts or role model. Loopback binding is the default boundary; `ADMIN_API_TOKEN` adds a bearer check to API mutations. Production automation remains disabled by default.

## Stop local services

```powershell
docker compose down
```

Use `docker compose down -v` only when you intentionally want to delete the local PostgreSQL and Redis data volumes.
