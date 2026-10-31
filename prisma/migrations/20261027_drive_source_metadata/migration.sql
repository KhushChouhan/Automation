ALTER TABLE "Video"
  ADD COLUMN "sourceSizeBytes" BIGINT,
  ADD COLUMN "sourceCreatedTime" TIMESTAMPTZ(3),
  ADD COLUMN "sourceModifiedTime" TIMESTAMPTZ(3);

ALTER TABLE "Video" ADD CONSTRAINT "Video_sourceSizeBytes_check"
  CHECK ("sourceSizeBytes" IS NULL OR "sourceSizeBytes" >= 0);
