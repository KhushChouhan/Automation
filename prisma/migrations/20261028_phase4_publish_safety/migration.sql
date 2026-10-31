ALTER TYPE "ScheduleStatus" ADD VALUE 'RECONCILE_REQUIRED';

ALTER TABLE "PublishAttempt"
  ADD COLUMN "leaseToken" TEXT,
  ADD COLUMN "leaseExpiresAt" TIMESTAMPTZ(3),
  ADD COLUMN "publishRequestedAt" TIMESTAMPTZ(3),
  ADD COLUMN "reconcileRequiredAt" TIMESTAMPTZ(3),
  ADD COLUMN "lastReconciledAt" TIMESTAMPTZ(3);

ALTER TABLE "PublishAttempt"
  ADD CONSTRAINT "PublishAttempt_lease_pair_check"
  CHECK (("leaseToken" IS NULL) = ("leaseExpiresAt" IS NULL));

ALTER TABLE "PublishAttempt"
  ADD CONSTRAINT "PublishAttempt_requested_container_check"
  CHECK ("status" NOT IN ('PUBLISH_REQUESTED', 'SUCCEEDED') OR "containerId" IS NOT NULL);

ALTER TABLE "PublishAttempt"
  ADD CONSTRAINT "PublishAttempt_success_media_check"
  CHECK ("status" <> 'SUCCEEDED' OR "mediaId" IS NOT NULL);

CREATE UNIQUE INDEX "PublishAttempt_one_active_per_schedule"
  ON "PublishAttempt" ("scheduleId")
  WHERE "status" IN ('CLAIMED', 'CONTAINER_CREATED', 'PROCESSING', 'PUBLISH_REQUESTED', 'RECONCILE_REQUIRED', 'SUCCEEDED');

CREATE INDEX "PublishAttempt_recovery_idx"
  ON "PublishAttempt" ("status", "leaseExpiresAt");
