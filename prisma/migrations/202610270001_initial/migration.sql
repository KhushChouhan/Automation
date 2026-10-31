-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "WorkflowStatus" AS ENUM ('WAITING_VIDEO', 'WAITING_FACE', 'WAITING_TITLE', 'WAITING_THUMBNAIL', 'WAITING_APPROVAL', 'READY', 'SELECTED', 'CONTENT_GENERATING', 'CONTENT_READY', 'SCHEDULED', 'PUBLISHING', 'POSTED', 'FAILED', 'RECONCILE_REQUIRED');

-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CHANGES_REQUIRED');

-- CreateEnum
CREATE TYPE "ScheduleStatus" AS ENUM ('SELECTED', 'SCHEDULED', 'PUBLISHING', 'POSTED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PublishAttemptStatus" AS ENUM ('CLAIMED', 'CONTAINER_CREATED', 'PROCESSING', 'PUBLISH_REQUESTED', 'RECONCILE_REQUIRED', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "FailureClass" AS ENUM ('TRANSIENT', 'RATE_LIMIT', 'AUTH', 'VALIDATION', 'PERMANENT', 'UNKNOWN', 'MANUAL_ACTION_REQUIRED');

-- CreateEnum
CREATE TYPE "OutboxStatus" AS ENUM ('PENDING', 'DELIVERED', 'FAILED');

-- CreateTable
CREATE TABLE "IdCounter" (
    "name" TEXT NOT NULL,
    "value" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "IdCounter_pkey" PRIMARY KEY ("name")
);

-- CreateTable
CREATE TABLE "Face" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Face_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Video" (
    "id" TEXT NOT NULL,
    "videoId" TEXT NOT NULL,
    "driveFileId" TEXT,
    "sourceName" TEXT,
    "sourceMimeType" TEXT,
    "sourceChecksum" TEXT,
    "title" TEXT,
    "faceId" TEXT,
    "workflowStatus" "WorkflowStatus" NOT NULL DEFAULT 'WAITING_VIDEO',
    "approvalStatus" "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "readyAt" TIMESTAMPTZ(3),
    "inputVersion" INTEGER NOT NULL DEFAULT 1,
    "manualActionRequired" BOOLEAN NOT NULL DEFAULT false,
    "manualActionReason" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Video_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Thumbnail" (
    "id" TEXT NOT NULL,
    "videoId" TEXT NOT NULL,
    "driveFileId" TEXT,
    "storageKey" TEXT,
    "checksum" TEXT,
    "mimeType" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Thumbnail_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Content" (
    "id" TEXT NOT NULL,
    "videoId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "titleSnapshot" TEXT NOT NULL,
    "caption" TEXT NOT NULL,
    "hashtags" TEXT[],
    "cta" TEXT NOT NULL,
    "modelName" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Content_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApprovalEvent" (
    "id" TEXT NOT NULL,
    "videoId" TEXT NOT NULL,
    "decision" "ApprovalStatus" NOT NULL,
    "actorId" TEXT NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApprovalEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Schedule" (
    "id" TEXT NOT NULL,
    "videoId" TEXT NOT NULL,
    "faceId" TEXT NOT NULL,
    "businessDate" VARCHAR(10) NOT NULL,
    "slotHour" INTEGER NOT NULL,
    "scheduledAt" TIMESTAMPTZ(3) NOT NULL,
    "status" "ScheduleStatus" NOT NULL DEFAULT 'SELECTED',
    "jobId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Schedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PublishAttempt" (
    "id" TEXT NOT NULL,
    "videoId" TEXT NOT NULL,
    "scheduleId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "status" "PublishAttemptStatus" NOT NULL DEFAULT 'CLAIMED',
    "containerId" TEXT,
    "mediaId" TEXT,
    "failureClass" "FailureClass",
    "errorCode" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "PublishAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PostingHistory" (
    "id" TEXT NOT NULL,
    "videoId" TEXT NOT NULL,
    "faceId" TEXT NOT NULL,
    "instagramMediaId" TEXT NOT NULL,
    "permalink" TEXT,
    "businessDate" VARCHAR(10) NOT NULL,
    "postedAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PostingHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutboxEvent" (
    "id" TEXT NOT NULL,
    "eventKey" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "OutboxStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "availableAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deliveredAt" TIMESTAMPTZ(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "OutboxEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutomationSetting" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "actorId" TEXT NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "AutomationSetting_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncCursor" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "accountKey" TEXT NOT NULL,
    "cursor" TEXT NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "SyncCursor_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Face_name_key" ON "Face"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Video_videoId_key" ON "Video"("videoId");

-- CreateIndex
CREATE UNIQUE INDEX "Video_driveFileId_key" ON "Video"("driveFileId");

-- CreateIndex
CREATE INDEX "Video_workflowStatus_readyAt_videoId_idx" ON "Video"("workflowStatus", "readyAt", "videoId");

-- CreateIndex
CREATE INDEX "Video_faceId_idx" ON "Video"("faceId");

-- CreateIndex
CREATE UNIQUE INDEX "Thumbnail_videoId_key" ON "Thumbnail"("videoId");

-- CreateIndex
CREATE UNIQUE INDEX "Thumbnail_driveFileId_key" ON "Thumbnail"("driveFileId");

-- CreateIndex
CREATE UNIQUE INDEX "Content_videoId_version_key" ON "Content"("videoId", "version");

-- CreateIndex
CREATE INDEX "ApprovalEvent_videoId_createdAt_idx" ON "ApprovalEvent"("videoId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Schedule_videoId_key" ON "Schedule"("videoId");

-- CreateIndex
CREATE UNIQUE INDEX "Schedule_scheduledAt_key" ON "Schedule"("scheduledAt");

-- CreateIndex
CREATE UNIQUE INDEX "Schedule_jobId_key" ON "Schedule"("jobId");

-- CreateIndex
CREATE INDEX "Schedule_faceId_businessDate_idx" ON "Schedule"("faceId", "businessDate");

-- CreateIndex
CREATE UNIQUE INDEX "Schedule_businessDate_slotHour_key" ON "Schedule"("businessDate", "slotHour");

-- CreateIndex
CREATE UNIQUE INDEX "Schedule_businessDate_faceId_key" ON "Schedule"("businessDate", "faceId");

-- CreateIndex
CREATE UNIQUE INDEX "PublishAttempt_idempotencyKey_key" ON "PublishAttempt"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "PublishAttempt_containerId_key" ON "PublishAttempt"("containerId");

-- CreateIndex
CREATE UNIQUE INDEX "PublishAttempt_mediaId_key" ON "PublishAttempt"("mediaId");

-- CreateIndex
CREATE INDEX "PublishAttempt_videoId_status_idx" ON "PublishAttempt"("videoId", "status");

-- CreateIndex
CREATE INDEX "PublishAttempt_scheduleId_idx" ON "PublishAttempt"("scheduleId");

-- CreateIndex
CREATE UNIQUE INDEX "PostingHistory_videoId_key" ON "PostingHistory"("videoId");

-- CreateIndex
CREATE UNIQUE INDEX "PostingHistory_instagramMediaId_key" ON "PostingHistory"("instagramMediaId");

-- CreateIndex
CREATE INDEX "PostingHistory_faceId_businessDate_idx" ON "PostingHistory"("faceId", "businessDate");

-- CreateIndex
CREATE UNIQUE INDEX "PostingHistory_businessDate_faceId_key" ON "PostingHistory"("businessDate", "faceId");

-- CreateIndex
CREATE UNIQUE INDEX "OutboxEvent_eventKey_key" ON "OutboxEvent"("eventKey");

-- CreateIndex
CREATE INDEX "OutboxEvent_status_availableAt_idx" ON "OutboxEvent"("status", "availableAt");

-- CreateIndex
CREATE INDEX "AuditLog_entity_entityId_createdAt_idx" ON "AuditLog"("entity", "entityId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "SyncCursor_source_accountKey_key" ON "SyncCursor"("source", "accountKey");

-- AddForeignKey
ALTER TABLE "Video" ADD CONSTRAINT "Video_faceId_fkey" FOREIGN KEY ("faceId") REFERENCES "Face"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Thumbnail" ADD CONSTRAINT "Thumbnail_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "Video"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Content" ADD CONSTRAINT "Content_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "Video"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovalEvent" ADD CONSTRAINT "ApprovalEvent_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "Video"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Schedule" ADD CONSTRAINT "Schedule_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "Video"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Schedule" ADD CONSTRAINT "Schedule_faceId_fkey" FOREIGN KEY ("faceId") REFERENCES "Face"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PublishAttempt" ADD CONSTRAINT "PublishAttempt_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "Video"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PublishAttempt" ADD CONSTRAINT "PublishAttempt_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "Schedule"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PostingHistory" ADD CONSTRAINT "PostingHistory_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "Video"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PostingHistory" ADD CONSTRAINT "PostingHistory_faceId_fkey" FOREIGN KEY ("faceId") REFERENCES "Face"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Domain invariants Prisma cannot express.
ALTER TABLE "Schedule" ADD CONSTRAINT "Schedule_slotHour_check" CHECK ("slotHour" IN (19, 20));
ALTER TABLE "Schedule" ADD CONSTRAINT "Schedule_businessDate_check" CHECK ("businessDate" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$');
ALTER TABLE "PostingHistory" ADD CONSTRAINT "PostingHistory_businessDate_check" CHECK ("businessDate" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$');
ALTER TABLE "IdCounter" ADD CONSTRAINT "IdCounter_value_check" CHECK ("value" >= 0);
CREATE UNIQUE INDEX "PublishAttempt_one_success_per_video" ON "PublishAttempt" ("videoId") WHERE "status" = 'SUCCEEDED'::"PublishAttemptStatus";

-- Human approvals, audit entries, and confirmed posts are append-only evidence.
CREATE FUNCTION prevent_evidence_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Evidence rows are append-only: %', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ApprovalEvent_append_only"
  BEFORE UPDATE OR DELETE ON "ApprovalEvent"
  FOR EACH ROW EXECUTE FUNCTION prevent_evidence_mutation();

CREATE TRIGGER "AuditLog_append_only"
  BEFORE UPDATE OR DELETE ON "AuditLog"
  FOR EACH ROW EXECUTE FUNCTION prevent_evidence_mutation();

CREATE TRIGGER "PostingHistory_append_only"
  BEFORE UPDATE OR DELETE ON "PostingHistory"
  FOR EACH ROW EXECUTE FUNCTION prevent_evidence_mutation();
