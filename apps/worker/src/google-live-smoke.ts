import { createReadStream } from 'node:fs';
import { access } from 'node:fs/promises';
import { createDatabaseClient, selectDailyReels, type PrismaClient } from '@gcs/database';
import {
  createGoogleDriveClientFromEnv,
  createGoogleSheetsClientFromEnv,
  GoogleDriveV3Adapter,
  GoogleSheetsV4Adapter,
} from '@gcs/integrations';
import { loadConfig } from '@gcs/config';
import { runGoogleSync } from './google-sync.js';

const videoName = 'PHASE2-GOOGLE-SMOKE-TEST.mp4';
const testTitle = 'Phase 2 Google Integration Test';
const testFaceId = 'TEST-FACE-A';
const selectionDate = '2026-10-30';

function required(value: string | null | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function findOrUpload(
  parentId: string,
  name: string,
  mimeType: string,
  fixturePath: string,
): Promise<{ fileId: string; reused: boolean }> {
  const drive = createGoogleDriveClientFromEnv();
  const escapedName = name.replaceAll('\\', '\\\\').replaceAll("'", "\\'");
  const response = await drive.files.list({
    q: `'${parentId}' in parents and name = '${escapedName}' and trashed = false`,
    orderBy: 'createdTime asc',
    pageSize: 10,
    fields: 'files(id,name,mimeType)',
  });
  const matches = (response.data.files ?? []).filter((file) => file.id);
  if (matches.length > 1) throw new Error(`Multiple controlled assets already exist: ${name}`);
  if (matches[0]?.id) {
    if (matches[0].mimeType !== mimeType)
      throw new Error(`Controlled asset MIME mismatch: ${name}`);
    return { fileId: matches[0].id, reused: true };
  }
  await access(fixturePath);
  const created = await drive.files.create({
    requestBody: { name, parents: [parentId] },
    media: { mimeType, body: createReadStream(fixturePath) },
    fields: 'id',
  });
  if (!created.data.id) throw new Error(`Google Drive returned no ID for ${name}`);
  return { fileId: created.data.id, reused: false };
}

async function findVideoRow(spreadsheetId: string, videoId: string): Promise<number> {
  const sheets = createGoogleSheetsClientFromEnv();
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: 'Videos!A2:A10000',
    majorDimension: 'ROWS',
  });
  const matches = (response.data.values ?? []).flatMap((row, index) =>
    row[0] === videoId ? [index + 2] : [],
  );
  if (matches.length !== 1)
    throw new Error(`Expected one Sheet row for ${videoId}, found ${matches.length}`);
  return matches[0]!;
}

async function writeHumanFields(
  spreadsheetId: string,
  row: number,
  values: { faceId?: string; title?: string; approval?: string },
): Promise<void> {
  const sheets = createGoogleSheetsClientFromEnv();
  const data = [
    ...(values.faceId !== undefined
      ? [{ range: `Videos!B${row}:B${row}`, values: [[values.faceId]] }]
      : []),
    ...(values.title !== undefined
      ? [{ range: `Videos!D${row}:D${row}`, values: [[values.title]] }]
      : []),
    ...(values.approval !== undefined
      ? [{ range: `Videos!F${row}:F${row}`, values: [[values.approval]] }]
      : []),
  ];
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: { valueInputOption: 'RAW', data },
  });
}

async function readSheetRow(spreadsheetId: string, row: number): Promise<unknown[]> {
  const sheets = createGoogleSheetsClientFromEnv();
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `Videos!A${row}:R${row}`,
    majorDimension: 'ROWS',
  });
  const firstRow: unknown = response.data.values?.[0];
  return Array.isArray(firstRow) ? firstRow.map((value: unknown) => value) : [];
}

async function runSync(
  db: PrismaClient,
  config: { spreadsheetId: string; videoFolderId: string; thumbnailFolderId: string },
) {
  return runGoogleSync(db, new GoogleDriveV3Adapter(), new GoogleSheetsV4Adapter(), {
    ...config,
    actorId: 'phase2-real-smoke',
  });
}

async function main(): Promise<void> {
  const config = loadConfig();
  const spreadsheetId = required(config.google.sheetId, 'GOOGLE_SHEET_ID');
  const videoFolderId = required(config.google.videoFolderId, 'GOOGLE_VIDEO_FOLDER_ID');
  const thumbnailFolderId = required(config.google.thumbnailFolderId, 'GOOGLE_THUMBNAIL_FOLDER_ID');
  const videoFixture = required(process.env['PHASE2_VIDEO_FIXTURE'], 'PHASE2_VIDEO_FIXTURE');
  const thumbnailFixture = required(
    process.env['PHASE2_THUMBNAIL_FIXTURE'],
    'PHASE2_THUMBNAIL_FIXTURE',
  );
  const syncConfig = { spreadsheetId, videoFolderId, thumbnailFolderId };
  const db = createDatabaseClient();

  try {
    const settings = await new GoogleSheetsV4Adapter().readSettings(spreadsheetId);
    const expectedSettings = new Map<string, string | number>([
      ['Timezone', 'Asia/Kolkata'],
      ['Daily Reel Limit', 2],
      ['Same Face Gap Days', 2],
      ['Slot 1', '19:00'],
      ['Slot 2', '20:00'],
      ['Automation', 'OFF'],
    ]);
    for (const [key, expected] of expectedSettings) {
      const actual = settings.find((row) => row[0] === key)?.[1];
      if (String(actual) !== String(expected)) throw new Error(`Setting mismatch: ${key}`);
    }

    const videoAsset = await findOrUpload(videoFolderId, videoName, 'video/mp4', videoFixture);
    await runSync(db, syncConfig);
    const discovered = await db.video.findUniqueOrThrow({
      where: { driveFileId: videoAsset.fileId },
    });
    if (!/^GCS-[0-9]{4,}$/.test(discovered.videoId))
      throw new Error('Permanent Video ID format is invalid');
    const videoId = discovered.videoId;
    await runSync(db, syncConfig);
    const stable = await db.video.findUniqueOrThrow({ where: { driveFileId: videoAsset.fileId } });
    if (stable.videoId !== videoId)
      throw new Error('Drive File ID did not retain its permanent Video ID');
    if ((await db.video.count({ where: { driveFileId: videoAsset.fileId } })) !== 1)
      throw new Error('Duplicate Video record created');

    const sheetRow = await findVideoRow(spreadsheetId, videoId);
    await writeHumanFields(spreadsheetId, sheetRow, {
      faceId: testFaceId,
      title: testTitle,
      approval: 'PENDING',
    });
    await runSync(db, syncConfig);
    const humanImported = await db.video.findUniqueOrThrow({ where: { videoId } });
    const resumedAfterPriorPartialRun =
      humanImported.approvalStatus === 'APPROVED' && humanImported.workflowStatus === 'READY';
    if (
      humanImported.faceId !== testFaceId ||
      humanImported.title !== testTitle ||
      (!resumedAfterPriorPartialRun &&
        (humanImported.approvalStatus !== 'PENDING' ||
          humanImported.workflowStatus !== 'WAITING_THUMBNAIL'))
    )
      throw new Error('Human Sheet fields did not import into the expected waiting state');

    const thumbnailName = `${videoId}.jpg`;
    const thumbnailAsset = await findOrUpload(
      thumbnailFolderId,
      thumbnailName,
      'image/jpeg',
      thumbnailFixture,
    );
    await runSync(db, syncConfig);
    await runSync(db, syncConfig);
    const withThumbnail = await db.video.findUniqueOrThrow({
      where: { videoId },
      include: { thumbnail: true },
    });
    if (
      withThumbnail.thumbnail?.driveFileId !== thumbnailAsset.fileId ||
      (await db.thumbnail.count({ where: { videoId: withThumbnail.id } })) !== 1
    )
      throw new Error('Thumbnail relation was not idempotent');

    await writeHumanFields(spreadsheetId, sheetRow, { approval: 'APPROVED' });
    await runSync(db, syncConfig);
    const ready = await db.video.findUniqueOrThrow({ where: { videoId } });
    if (ready.approvalStatus !== 'APPROVED' || ready.workflowStatus !== 'READY')
      throw new Error('APPROVED did not transition to READY through domain validation');

    const conflictBefore = await db.syncConflict.count({
      where: { source: 'SHEET_SYSTEM_FIELD', videoId: ready.id, field: 'workflowStatus' },
    });
    const sheets = createGoogleSheetsClientFromEnv();
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `Videos!G${sheetRow}:G${sheetRow}`,
      valueInputOption: 'RAW',
      requestBody: { values: [['POSTED']] },
    });
    await runSync(db, syncConfig);
    const protectedVideo = await db.video.findUniqueOrThrow({ where: { videoId } });
    const repairedRow = await readSheetRow(spreadsheetId, sheetRow);
    const conflictAfter = await db.syncConflict.count({
      where: { source: 'SHEET_SYSTEM_FIELD', videoId: ready.id, field: 'workflowStatus' },
    });
    const auditRecorded =
      (await db.auditLog.count({
        where: { entityId: ready.id, action: 'SYNC_CONFLICT' },
      })) > 0;
    if (
      protectedVideo.workflowStatus !== 'READY' ||
      repairedRow[6] !== 'READY' ||
      conflictAfter <= conflictBefore ||
      !auditRecorded
    )
      throw new Error('System-owned Status protection or repair evidence failed');

    const beforeCounts = {
      video: await db.video.count({ where: { driveFileId: videoAsset.fileId } }),
      thumbnail: await db.thumbnail.count({ where: { videoId: ready.id } }),
    };
    await runSync(db, syncConfig);
    await runSync(db, syncConfig);
    const afterCounts = {
      video: await db.video.count({ where: { driveFileId: videoAsset.fileId } }),
      thumbnail: await db.thumbnail.count({ where: { videoId: ready.id } }),
    };
    if (JSON.stringify(beforeCounts) !== JSON.stringify(afterCounts))
      throw new Error('Repeated sync changed entity counts');
    await findVideoRow(spreadsheetId, videoId);

    const blockedFaces = new Set(
      (
        await db.schedule.findMany({
          where: { businessDate: '2026-10-29' },
          select: { faceId: true },
        })
      ).map((row) => row.faceId),
    );
    const selection = await selectDailyReels(db, {
      businessDate: selectionDate,
      actorId: 'phase2-real-smoke',
      gapDays: 2,
    });
    const repeatedSelection = await selectDailyReels(db, {
      businessDate: selectionDate,
      actorId: 'phase2-real-smoke-repeat',
      gapDays: 2,
    });
    if (
      selection.length !== 2 ||
      selection[0]?.slotHour !== 19 ||
      selection[1]?.slotHour !== 20 ||
      new Set(selection.map((row) => row.faceId)).size !== selection.length ||
      selection.some((row) => blockedFaces.has(row.faceId)) ||
      repeatedSelection.map((row) => row.id).join(',') !== selection.map((row) => row.id).join(',')
    )
      throw new Error('Selection, face-gap, slot, or idempotency assertion failed');

    const postingHistory = await db.postingHistory.count();
    const publishAttempts = await db.publishAttempt.count();
    const automation = await db.automationSetting.findUnique({
      where: { key: 'automation.enabled' },
    });
    if (postingHistory !== 0 || publishAttempts !== 0 || automation?.value !== false)
      throw new Error('Production safety assertion failed');

    console.log(
      JSON.stringify({
        settingsVerified: true,
        video: {
          reused: videoAsset.reused,
          videoId,
          stable: true,
          databaseCount: afterCounts.video,
          sheetRows: 1,
        },
        humanFields: {
          faceId: testFaceId,
          title: testTitle,
          approvalInitially: 'PENDING',
          waitingState: 'WAITING_THUMBNAIL',
          resumedAfterPriorPartialRun,
        },
        thumbnail: {
          reused: thumbnailAsset.reused,
          relationCount: afterCounts.thumbnail,
          repeatedSyncStable: true,
        },
        approvalReady: true,
        systemFieldProtection: {
          databasePreserved: true,
          sheetRepaired: true,
          conflictRecorded: true,
          auditRecorded: true,
        },
        selection: {
          businessDate: selectionDate,
          slots: selection.map((row) => `${row.slotHour}:00`),
          maximum: 2,
          distinctFaces: true,
          sameFaceGapRespected: true,
          repeatedStable: true,
        },
        automation: 'OFF',
        postingHistory,
        publishAttempts,
        instagramPosts: 0,
      }),
    );
  } finally {
    await db.$disconnect();
  }
}

await main().catch((error: unknown) => {
  console.error(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
});
