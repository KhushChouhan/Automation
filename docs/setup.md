# Local setup

Use Node.js 22+, pnpm 11.25+, and Docker Compose. Copy `.env.example` to ignored `.env`, fill a private `ADMIN_API_TOKEN` and independent `DASHBOARD_PASSWORD`, then install and build. Never overwrite an existing environment containing credentials.

```powershell
pnpm install --frozen-lockfile
pnpm db:generate
docker compose up -d
pnpm db:migrate
pnpm db:seed
pnpm build
```

These commands target the explicitly configured local database. Seeding writes fixture videos and today's two schedules; do not seed an existing production database. PostgreSQL binds to loopback port 5432; Redis 7 binds to port 6380 to avoid legacy Redis 3 on 6379. Keep `REDIS_URL=redis://127.0.0.1:6380` consistent in every local process. Use this one Compose Redis or an existing verified Redis 7/8, not both.

Run separate terminals after building:

```powershell
pnpm start:api
pnpm start:worker
pnpm start:admin
```

Open `http://localhost:3000`. The admin fetches server-side `API_BASE_URL=http://127.0.0.1:8000` and forwards the private token. Dashboard browser access requires its separate username/password. `/health` and `/readiness` are safe public health probes; operational data and mutation routes require the API token. Provider status checks report presence/readiness without exposing secret values. Publishing and automation default OFF.

Optional Google configuration belongs in ignored local environment or a deployment secret store. For OAuth supply `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`, `GOOGLE_SHEET_ID`, `GOOGLE_VIDEO_FOLDER_ID`, and `GOOGLE_THUMBNAIL_FOLDER_ID`. Service-account mode uses `GOOGLE_SERVICE_ACCOUNT_JSON`. Archive folder configuration is required only if archiving is explicitly enabled. Provider credentials authorize real provider work: leave them blank for fake-only QA. Do not commit or print secrets.

Stop local services with `docker compose down`. Adding `-v` deletes the local PostgreSQL/Redis volumes and must be intentional. For Render, Railway, Vercel and managed data services, follow [deployment and recovery](deployment.md).
