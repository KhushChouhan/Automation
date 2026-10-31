# Testing and local verification

## Automated checks

Run the repository checks from the workspace root:

```powershell
pnpm test
pnpm typecheck
pnpm lint
pnpm format:check
pnpm build
```

The default suite uses fakes and skips two PostgreSQL-only assertions. To run permanent Drive-ID and concurrent-selector checks against a migrated test database, set `TEST_DATABASE_URL` for that command. Never point it at production.

The suite covers workflow transitions, validation, IST timezone boundaries, face-gap rules, liveness, database/Redis readiness reporting, read-only dashboard response shape, slot labels, count aggregation, stable source identity, and concurrent selection.

## Local smoke checks

With Compose services and the API running, request:

```powershell
Invoke-RestMethod http://127.0.0.1:3001/health
Invoke-RestMethod http://127.0.0.1:3001/readiness
Invoke-RestMethod http://127.0.0.1:3001/api/v1/dashboard
```

After seeding, compare the dashboard inventory against PostgreSQL rows. It should show GCS-0001/Aarav at 19:00, GCS-0003/Meera at 20:00, and GCS-0002/Aarav still ready and unscheduled. When stopping Redis or PostgreSQL, readiness should respond with HTTP 503 and identify only which dependency is unavailable, without returning connection strings or error details.

These checks do not verify authentication, Google/Meta connectivity, publishing, or production recovery; those remain later release gates.
