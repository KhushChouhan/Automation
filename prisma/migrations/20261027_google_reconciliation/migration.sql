CREATE TABLE "UnmatchedThumbnail" (
  "id" TEXT NOT NULL,
  "driveFileId" TEXT NOT NULL,
  "sourceName" TEXT NOT NULL,
  "checksum" TEXT,
  "mimeType" TEXT,
  "candidateId" TEXT,
  "reason" TEXT NOT NULL,
  "firstSeenAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "UnmatchedThumbnail_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "UnmatchedThumbnail_driveFileId_key" ON "UnmatchedThumbnail"("driveFileId");
CREATE INDEX "UnmatchedThumbnail_candidateId_idx" ON "UnmatchedThumbnail"("candidateId");

CREATE TABLE "SheetRowSync" (
  "id" TEXT NOT NULL,
  "spreadsheetId" TEXT NOT NULL,
  "videoId" TEXT NOT NULL,
  "rowVersion" TEXT,
  "lastSyncedHuman" JSONB NOT NULL,
  "lastImportedHash" TEXT,
  "lastMirroredHash" TEXT,
  "lastMirroredVersion" TEXT,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "SheetRowSync_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SheetRowSync_spreadsheetId_videoId_key" ON "SheetRowSync"("spreadsheetId", "videoId");
ALTER TABLE "SheetRowSync" ADD CONSTRAINT "SheetRowSync_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "Video"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "SyncConflict" (
  "id" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "sourceKey" TEXT NOT NULL,
  "videoId" TEXT,
  "field" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "fingerprint" TEXT NOT NULL,
  "databaseValue" JSONB,
  "incomingValue" JSONB,
  "resolvedAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SyncConflict_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SyncConflict_fingerprint_key" ON "SyncConflict"("fingerprint");
CREATE INDEX "SyncConflict_source_sourceKey_resolvedAt_idx" ON "SyncConflict"("source", "sourceKey", "resolvedAt");
CREATE INDEX "SyncConflict_videoId_resolvedAt_idx" ON "SyncConflict"("videoId", "resolvedAt");
ALTER TABLE "SyncConflict" ADD CONSTRAINT "SyncConflict_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "Video"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
