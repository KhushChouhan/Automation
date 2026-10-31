import { createDatabaseClient, selectDailyReels } from '@gcs/database';
import { loadConfig } from '@gcs/config';
import type { ContentGenerator } from '@gcs/core';
import { GoogleDriveV3Adapter, GoogleSheetsV4Adapter, LocalMediaStorage } from '@gcs/integrations';
import type { Job } from 'bullmq';
import { runGoogleSync } from './google-sync.js';
import {
  createContentProcessor,
  createMediaPreparationProcessor,
  type ContentProcessorResult,
  type MediaProcessorResult,
} from './phase3.js';

const VIDEO_ID = 'GCS-0021';
const TARGET_DATE = '2026-11-02';

const fakeGenerator: ContentGenerator = {
  generate: (input) =>
    Promise.resolve({
      caption: `${input.title} — a concise project walkthrough based only on the approved title. Verify plot-specific details before deciding.`,
      hashtags: ['#JaipurRealEstate', '#PropertyAwareness', '#GreenCitySEZ'],
      cta: 'DM for verified, plot-specific details.',
      model: 'fake-phase3-smoke',
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    }),
};

const config = loadConfig();
const db = createDatabaseClient();

try {
  let video = await db.video.findUniqueOrThrow({
    where: { videoId: VIDEO_ID },
    include: { schedule: true },
  });
  if (video.workflowStatus === 'READY') {
    await selectDailyReels(db, {
      businessDate: TARGET_DATE,
      actorId: 'phase3-local-smoke',
      gapDays: config.faceGapDays,
    });
    video = await db.video.findUniqueOrThrow({
      where: { videoId: VIDEO_ID },
      include: { schedule: true },
    });
  }
  if (!video.schedule) throw new Error(`${VIDEO_ID} was not selected for the controlled date`);

  const contentProcessor = createContentProcessor(db, config, fakeGenerator);
  const contentJob = {
    id: `phase3-fake-content-${VIDEO_ID}`,
    data: { videoId: VIDEO_ID, actorId: 'phase3-local-smoke' },
  } as unknown as Job<Record<string, unknown>, ContentProcessorResult>;
  const firstContent = await contentProcessor(contentJob);
  const repeatedContent = await contentProcessor(contentJob);

  const storage = new LocalMediaStorage(config.media.localDirectory);
  const mediaProcessor = createMediaPreparationProcessor(db, config, storage);
  const mediaJob = {
    id: `phase3-local-media-${video.schedule.id}`,
    data: { videoId: VIDEO_ID, scheduleId: video.schedule.id },
  } as unknown as Job<Record<string, unknown>, MediaProcessorResult>;
  const firstMedia = await mediaProcessor(mediaJob);
  const repeatedMedia = await mediaProcessor(mediaJob);

  if (!config.google.sheetId || !config.google.videoFolderId || !config.google.thumbnailFolderId)
    throw new Error('Google integration resource IDs are incomplete');
  const drive = new GoogleDriveV3Adapter();
  const sheet = new GoogleSheetsV4Adapter();
  const sync = await runGoogleSync(db, drive, sheet, {
    spreadsheetId: config.google.sheetId,
    videoFolderId: config.google.videoFolderId,
    thumbnailFolderId: config.google.thumbnailFolderId,
    actorId: 'phase3-local-smoke',
  });
  const row = (await sheet.readVideoRows(config.google.sheetId, 'Videos!A1:R10000')).find(
    (item) => item.videoId === VIDEO_ID,
  );
  const final = await db.video.findUniqueOrThrow({
    where: { videoId: VIDEO_ID },
    include: {
      face: true,
      content: { orderBy: { version: 'desc' } },
      schedule: { include: { mediaAsset: true } },
      postingHistory: true,
      publishAttempts: true,
    },
  });
  const storedThumbnail = final.schedule?.mediaAsset?.thumbnailObjectKey
    ? await storage.head(final.schedule.mediaAsset.thumbnailObjectKey)
    : null;
  console.log(
    JSON.stringify({
      videoId: final.videoId,
      title: final.title,
      face: final.face?.name ?? null,
      approval: final.approvalStatus,
      workflowStatus: final.workflowStatus,
      contentVersions: final.content.length,
      contentResult: { first: firstContent, repeated: repeatedContent },
      schedule: final.schedule
        ? {
            businessDate: final.schedule.businessDate,
            slotHour: final.schedule.slotHour,
            scheduledAtUtc: final.schedule.scheduledAt.toISOString(),
          }
        : null,
      mediaResult: { first: firstMedia, repeated: repeatedMedia },
      mediaAsset: final.schedule?.mediaAsset
        ? {
            status: final.schedule.mediaAsset.status,
            provider: final.schedule.mediaAsset.provider,
            objectKey: final.schedule.mediaAsset.videoObjectKey,
            sizeBytes: String(final.schedule.mediaAsset.sizeBytes),
            thumbnailPrepared: Boolean(storedThumbnail),
          }
        : null,
      sheet: row
        ? {
            title: row.title ?? null,
            faceId: row.faceId ?? null,
            approval: row.approvalStatus ?? null,
            status: row.status ?? null,
            captionPresent: Boolean(row.caption),
            hashtagsPresent: Boolean(row.hashtags),
          }
        : null,
      sync: {
        rowsRead: sync.sheetRowsRead,
        rowsMirrored: sync.rowsMirrored,
        conflicts: sync.sheetConflicts,
      },
      postingHistoryCount: final.postingHistory ? 1 : 0,
      publishAttemptCount: final.publishAttempts.length,
      metaRequests: 0,
      automationEnabled: config.automationEnabled,
    }),
  );
} finally {
  await db.$disconnect();
}
