CREATE TYPE "MediaPreparationStatus" AS ENUM ('PREPARING', 'READY', 'FAILED', 'CLEANED');

ALTER TABLE "Content"
ADD COLUMN "generationKey" TEXT,
ADD COLUMN "usage" JSONB,
ADD COLUMN "regenerated" BOOLEAN NOT NULL DEFAULT false;

UPDATE "Content"
SET "generationKey" = md5("videoId" || ':' || "version"::text || ':' || "promptVersion")
WHERE "generationKey" IS NULL;

ALTER TABLE "Content" ALTER COLUMN "generationKey" SET NOT NULL;
CREATE UNIQUE INDEX "Content_generationKey_key" ON "Content"("generationKey");

CREATE TABLE "MediaAsset" (
  "id" TEXT NOT NULL,
  "videoId" TEXT NOT NULL,
  "scheduleId" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "bucket" TEXT,
  "videoObjectKey" TEXT NOT NULL,
  "thumbnailObjectKey" TEXT,
  "contentType" TEXT NOT NULL,
  "sizeBytes" BIGINT NOT NULL,
  "checksum" TEXT,
  "status" "MediaPreparationStatus" NOT NULL DEFAULT 'PREPARING',
  "expiresAt" TIMESTAMPTZ(3),
  "preparedAt" TIMESTAMPTZ(3),
  "cleanedAt" TIMESTAMPTZ(3),
  "lastError" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "MediaAsset_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MediaAsset_scheduleId_key" ON "MediaAsset"("scheduleId");
CREATE UNIQUE INDEX "MediaAsset_videoObjectKey_key" ON "MediaAsset"("videoObjectKey");
CREATE INDEX "MediaAsset_status_expiresAt_idx" ON "MediaAsset"("status", "expiresAt");
CREATE INDEX "MediaAsset_videoId_idx" ON "MediaAsset"("videoId");
ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "Video"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "Schedule"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
