# Agent State

## Architecture decisions

- `PROJECT_BLUEPRINT.md` is the architecture and business-rule source of truth.
- Greenfield pnpm TypeScript monorepo with API, worker, and admin runtimes.
- PostgreSQL is authoritative; Redis/BullMQ provides at-least-once job delivery.
- Business timezone is `Asia/Kolkata`; slots are 19:00 and 20:00; limit is two.
- Production automation defaults OFF. Meta publishing remains disabled; Google is the only real Phase 2 integration.
- REA skipped: repository contained no application code at milestone start.
- Model mapping: current Luna for routine work; Sol 6 for architecture-sensitive logic.

## Current phase

Phase 3: content generation, durable orchestration, temporary media preparation, and operator controls. Phase 2 remains the Google integration regression baseline. Real Cloudinary acceptance is complete; OpenAI remains blocked on an historically opaque 429. Meta publishing remains disabled.

## Agent assignments

- Data/Domain: reconciliation, field ownership, conflicts, sync transactions, schema changes.
- Google Integration: authentication, Drive/Sheets adapters, scoped discovery, retries, cursors.
- QA/Reliability: mocks, idempotency, conflicts, retries, concurrent sync tests.
- DevOps/Security/Dashboard: credentials, Google status/health/API, manual sync controls, minimal UI.

## Completed milestones

- Architecture blueprint accepted.
- Monorepo, core domain, Prisma migration, selection/outbox, fake adapters, BullMQ foundation, API, worker, and read-only admin implemented.
- PostgreSQL migration and five-video seed succeeded.
- Live selection demonstrated: GCS-0001/Aarav at 19:00, GCS-0003/Meera at 20:00, GCS-0002 remains ready.
- 35 tests including live PostgreSQL concurrency, typecheck, lint, formatting, and production build passed.
- API health/readiness and dashboard visually verified; automation remains OFF.
- Real Drive/Sheets adapters, OAuth bootstrap, scoped folder/change polling, reconciliation, conflict handling, Sheet mirror, worker orchestration, status APIs, and dashboard controls are implemented.
- Connected-account read-only verification confirmed the existing Instagram Reel Automation folder, Videos/Thumbnails/Archive subfolders, control Sheet, three required tabs, empty media folders, and unchanged settings.
- Phase 2 fake-adapter/live-PostgreSQL verification reached 61 passing tests; typecheck, lint, formatting, and production builds pass with a 4 GB Node heap.
- Controlled 2026-10-29 selection produced 19:00 and 20:00 IST schedules for different faces; repeating selection preserved two schedules. PostingHistory and PublishAttempt remain empty.
- OAuth for `khushchouhan9680@gmail.com` now grants full Drive plus Sheets read/write access. A duplicate-safe bootstrap reused that account's exact root/Videos/Thumbnails/Archive folders, created and configured one control Sheet, and saved the new resource IDs in ignored `.env.local`.
- The real Phase 2 smoke assigned `GCS-0021` to one controlled Drive video, proved stable ID and Sheet mirroring, imported `TEST-FACE-A` plus the test title, matched one thumbnail idempotently, transitioned APPROVED to READY through domain validation, repaired a tampered system Status with conflict/audit evidence, and selected distinct faces at 19:00/20:00 on 2026-10-30 without violating the two-day gap.
- Phase 3 now includes a core `ContentGenerator` port, OpenAI Responses/Structured Outputs adapter, versioned prompt/model configuration, deterministic generation identity, bounded classified retries, versioned content persistence, and explicit regeneration auditing.
- BullMQ 5 Job Schedulers, transactional outbox dispatch, deterministic queue IDs, Redis restart recovery, queue status APIs, and a hard `metaRequests: 0` publish safety processor are implemented and verified.
- Provider-independent local/Cloudinary/R2 media storage supports streaming upload, metadata checks, temporary private read URLs, idempotent delete/cleanup, deterministic video/thumbnail keys, and persistent media metadata. Cloudinary is the primary real provider; R2 is optional legacy support. The Cloudinary adapter selects video/image resource types, uses overwrite-safe public IDs, and classifies auth/rate/transient failures.
- Real Cloudinary acceptance for GCS-0021 passed: its existing Google Drive video and thumbnail uploaded as `video` and `image`, persisted as one `cloudinary` READY MediaAsset, repeated preparation reused that asset, a private URL was reachable with bounded expiry, and a disposable image upload/delete/repeat-delete smoke passed. Source Drive assets were retained.
- Controlled `GCS-0021` acceptance generated one fake-adapter content version, reused it idempotently, streamed the real Drive video and thumbnail to local storage, mirrored Caption/Hashtags without changing Title/Face/Approval, and stopped at `SCHEDULED` with no PostingHistory or PublishAttempt.
- Dashboard queue visibility, content/media state, caption/hashtags/CTA, Cloudinary configuration status, and backend-driven manual content/media controls are live. Serialized verification passes 83 tests across 20 files, typecheck, lint, formatting, production builds, API readiness, queue health, and rendered dashboard inspection.

## Unresolved blockers

- Docker CLI is unavailable on this machine; Compose is authored but not executed. Native PostgreSQL 17 and Redis 8.10 were used for acceptance.
- The OpenAI key is locally configured. The single controlled `GCS-0021` regeneration reached OpenAI but exhausted bounded retries with HTTP 429. Historical safe records retain only the sanitized RATE_LIMIT classification, not OpenAI `error.type` or `error.code`, so it is an unknown 429 and must not be retried until the account limit is clarified. Existing content, approved Title, SCHEDULED state, and media evidence were preserved.

## Known API limitations

- Parallel DB test files can race when sharing one test database; the serialized full suite passes. The worker now skips rows removed between mirror reads.
- In-app browser visual inspection of the new control Sheet was unavailable because that browser is signed into a different Google account; authenticated Sheets API readback verified tabs, values, formatting metadata, frozen headers, and validations.

## Next actionable step

Clarify the OpenAI API account's 429 cause before retrying the controlled generation; do not retry while the `error.type` and `error.code` remain unknown. Keep Automation OFF and Instagram publishing disabled.
