import { createHash } from 'node:crypto';
import {
  discoverVideo,
  prepareSheetMirrorRow,
  reconcileDriveThumbnails,
  reconcileSheetRows,
  recordSheetMirror,
  setAutomationSetting,
  Prisma,
  type PrismaClient,
} from '@gcs/database';
import {
  googleDriveFileIdFromLink,
  type DriveChangePage,
  type DriveVideoAsset,
  type GoogleDriveFile,
  type SheetPostingHistoryRow,
  type SheetVideoRow,
} from '@gcs/integrations';

const VIDEO_MIME_TYPES = new Set(['video/mp4', 'video/quicktime', 'video/webm']);
const THUMBNAIL_MIME_TYPES = new Set(['image/jpeg', 'image/png']);

export interface DriveSyncPort {
  listVideoAssets(folderId: string): Promise<DriveVideoAsset[]>;
  listFolderFiles(folderId: string): Promise<GoogleDriveFile[]>;
  getStartPageToken(): Promise<string>;
  listChanges(pageToken: string): Promise<DriveChangePage>;
}

export interface SheetSyncPort {
  readVideoRows(spreadsheetId: string, range: string): Promise<SheetVideoRow[]>;
  readSettings(spreadsheetId: string, range?: string): Promise<unknown[][]>;
  mirrorVideoRows(spreadsheetId: string, rows: SheetVideoRow[]): Promise<void>;
  mirrorPostingHistory(spreadsheetId: string, rows: SheetPostingHistoryRow[]): Promise<void>;
}

export interface GoogleSyncConfig {
  spreadsheetId: string;
  videoFolderId: string;
  thumbnailFolderId: string;
  actorId?: string;
}

export interface GoogleSyncResult {
  videosDiscovered: number;
  thumbnailsMatched: number;
  unmatchedThumbnails: number;
  sheetRowsRead: number;
  sheetRowsInvalid: number;
  sheetConflicts: number;
  rowsMirrored: number;
  postingHistoryMirrored: number;
  settingsApplied: string[];
  invalidSettings: string[];
  cursor: string | null;
}

function auditId(action: string): string {
  return `google-sync:${action}:${crypto.randomUUID()}`;
}

async function audit(
  db: PrismaClient,
  actorId: string,
  action: string,
  after?: Record<string, unknown>,
): Promise<void> {
  await db.auditLog.create({
    data: {
      actorId,
      action,
      entity: 'GoogleSync',
      entityId: auditId(action),
      ...(after ? { after: after as Prisma.InputJsonValue } : {}),
    },
  });
}

function driveLink(fileId: string | null): string {
  return fileId ? `https://drive.google.com/file/d/${encodeURIComponent(fileId)}/view` : '';
}

function humanAndProtectedFields(row: SheetVideoRow) {
  return {
    videoId: row.videoId,
    ...(row.title !== undefined ? { title: row.title } : {}),
    ...(row.faceId !== undefined ? { faceId: row.faceId } : {}),
    ...(row.approvalStatus !== undefined ? { approvalStatus: row.approvalStatus } : {}),
    ...(row.status !== undefined ? { workflowStatus: row.status } : {}),
    ...(row.instagramMediaId !== undefined ? { instagramMediaId: row.instagramMediaId } : {}),
    ...(row.instagramPermalink !== undefined ? { permalink: row.instagramPermalink } : {}),
    ...(row.postedDate !== undefined ? { postedAt: row.postedDate } : {}),
  };
}

/**
 * Drive discovery owns permanent GCS allocation. A human may add a Sheet row
 * with only a Drive link; once that file is discovered, enrich that row with
 * its stable ID before the normal three-way Sheet reconciliation.
 */
async function resolveSheetVideoIds(
  db: PrismaClient,
  rows: SheetVideoRow[],
): Promise<SheetVideoRow[]> {
  const missingLinks = [
    ...new Set(
      rows
        .filter((row) => !row.videoId.trim() && row.videoLink)
        .map((row) => googleDriveFileIdFromLink(row.videoLink)),
    ),
  ].filter((id): id is string => Boolean(id));
  if (missingLinks.length === 0) return rows;
  const videos = await db.video.findMany({
    where: { driveFileId: { in: missingLinks } },
    select: { driveFileId: true, videoId: true },
  });
  const videoIdByDriveFileId = new Map(
    videos.flatMap((video) =>
      video.driveFileId ? [[video.driveFileId, video.videoId] as const] : [],
    ),
  );
  return rows.map((row) => {
    if (row.videoId.trim()) return row;
    const driveFileId = googleDriveFileIdFromLink(row.videoLink);
    const videoId = driveFileId ? videoIdByDriveFileId.get(driveFileId) : undefined;
    return videoId ? { ...row, videoId } : row;
  });
}

function settingRows(values: unknown[][]): Map<string, unknown> {
  const settings = new Map<string, unknown>();
  for (const row of values) {
    if (typeof row[0] !== 'string') continue;
    const key = row[0]
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '');
    if (key && key !== 'setting' && key !== 'key') settings.set(key, row[1]);
  }
  return settings;
}

function stringCell(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function parseInteger(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(stringCell(value));
  return Number.isSafeInteger(parsed) ? parsed : null;
}

async function importSettings(
  db: PrismaClient,
  values: unknown[][],
  actorId: string,
): Promise<{ applied: string[]; invalid: string[] }> {
  const source = settingRows(values);
  const candidates: Array<{ key: string; value: unknown }> = [];
  if (source.has('timezone'))
    candidates.push({ key: 'business.timezone', value: stringCell(source.get('timezone')) });
  if (source.has('dailyreellimit'))
    candidates.push({ key: 'daily.limit', value: parseInteger(source.get('dailyreellimit')) });
  if (source.has('samefacegapdays'))
    candidates.push({
      key: 'face.rotationGapDays',
      value: parseInteger(source.get('samefacegapdays')),
    });
  if (source.has('slot1') || source.has('slot2'))
    candidates.push({
      key: 'schedule.slots',
      value: [stringCell(source.get('slot1')), stringCell(source.get('slot2'))],
    });
  if (source.has('automation'))
    candidates.push({
      key: 'automation.enabled',
      value: stringCell(source.get('automation')).toUpperCase() === 'ON',
    });

  const applied: string[] = [];
  const invalid: string[] = [];
  for (const candidate of candidates) {
    try {
      await setAutomationSetting(db, { ...candidate, actorId });
      applied.push(candidate.key);
    } catch {
      invalid.push(candidate.key);
      const fingerprint = createHash('sha256')
        .update(`SHEET_SETTINGS\0${candidate.key}\0${JSON.stringify(candidate.value)}`)
        .digest('hex');
      await db.syncConflict.upsert({
        where: { fingerprint },
        create: {
          source: 'SHEET_SETTINGS',
          sourceKey: candidate.key,
          field: candidate.key,
          reason: 'INVALID_SETTING',
          fingerprint,
          incomingValue: candidate.value as never,
        },
        update: { resolvedAt: null },
      });
    }
  }
  return { applied, invalid };
}

async function driveAssets(
  db: PrismaClient,
  drive: DriveSyncPort,
  config: GoogleSyncConfig,
): Promise<{ videos: DriveVideoAsset[]; thumbnails: GoogleDriveFile[]; cursor: string }> {
  const accountKey = `${config.videoFolderId}:${config.thumbnailFolderId}`;
  const saved = await db.syncCursor.findUnique({
    where: { source_accountKey: { source: 'GOOGLE_DRIVE_CHANGES', accountKey } },
  });
  if (!saved) {
    const [videos, thumbnails, cursor] = await Promise.all([
      drive.listVideoAssets(config.videoFolderId),
      drive.listFolderFiles(config.thumbnailFolderId),
      drive.getStartPageToken(),
    ]);
    return { videos, thumbnails, cursor };
  }

  const changed: GoogleDriveFile[] = [];
  let pageToken = saved.cursor;
  let finalCursor = saved.cursor;
  for (;;) {
    const page = await drive.listChanges(pageToken);
    changed.push(...page.changes);
    if (page.nextPageToken) {
      pageToken = page.nextPageToken;
      continue;
    }
    finalCursor = page.newStartPageToken ?? pageToken;
    break;
  }
  const inFolder = (file: GoogleDriveFile, folderId: string) => file.parents?.includes(folderId);
  return {
    videos: changed
      .filter((file) => inFolder(file, config.videoFolderId) && VIDEO_MIME_TYPES.has(file.mimeType))
      .map((file) => ({
        fileId: file.fileId,
        name: file.name,
        mimeType: file.mimeType,
        ...(file.size !== undefined ? { size: file.size } : {}),
        ...(file.createdTime ? { createdTime: file.createdTime } : {}),
        ...(file.modifiedTime ? { modifiedTime: file.modifiedTime } : {}),
        ...(file.webViewLink ? { webViewLink: file.webViewLink } : {}),
        ...(file.checksum ? { checksum: file.checksum } : {}),
      })),
    thumbnails: changed.filter((file) => inFolder(file, config.thumbnailFolderId)),
    cursor: finalCursor,
  };
}

export class GoogleSyncRunError extends Error {
  constructor(
    readonly failures: string[],
    readonly result: GoogleSyncResult,
  ) {
    super(`Google sync failed in: ${failures.join(', ')}`);
    this.name = 'GoogleSyncRunError';
  }
}

/** Runs scoped, idempotent Drive -> DB -> Sheet reconciliation. It never publishes to Instagram. */
export async function runGoogleSync(
  db: PrismaClient,
  drive: DriveSyncPort,
  sheet: SheetSyncPort,
  config: GoogleSyncConfig,
): Promise<GoogleSyncResult> {
  const actorId = config.actorId ?? 'google-sync-worker';
  const result: GoogleSyncResult = {
    videosDiscovered: 0,
    thumbnailsMatched: 0,
    unmatchedThumbnails: 0,
    sheetRowsRead: 0,
    sheetRowsInvalid: 0,
    sheetConflicts: 0,
    rowsMirrored: 0,
    postingHistoryMirrored: 0,
    settingsApplied: [],
    invalidSettings: [],
    cursor: null,
  };
  const failures: string[] = [];

  await audit(db, actorId, 'GOOGLE_DRIVE_SYNC_STARTED');
  try {
    const assets = await driveAssets(db, drive, config);
    for (const asset of assets.videos.filter((item) => VIDEO_MIME_TYPES.has(item.mimeType))) {
      await discoverVideo(db, {
        driveFileId: asset.fileId,
        sourceName: asset.name,
        sourceMimeType: asset.mimeType,
        ...(asset.checksum ? { sourceChecksum: asset.checksum } : {}),
        ...(asset.size !== undefined ? { sourceSizeBytes: asset.size } : {}),
        ...(asset.createdTime ? { sourceCreatedTime: asset.createdTime } : {}),
        ...(asset.modifiedTime ? { sourceModifiedTime: asset.modifiedTime } : {}),
      });
      result.videosDiscovered += 1;
    }
    const thumbnails = assets.thumbnails
      .filter((item) => THUMBNAIL_MIME_TYPES.has(item.mimeType))
      .map((item) => ({
        fileId: item.fileId,
        name: item.name,
        mimeType: item.mimeType,
        ...(item.checksum ? { checksum: item.checksum } : {}),
      }));
    const thumbnailResult = await reconcileDriveThumbnails(db, thumbnails, actorId);
    result.thumbnailsMatched = thumbnailResult.attached.length;
    result.unmatchedThumbnails = thumbnailResult.unmatched.length;
    result.cursor = assets.cursor;
    await db.syncCursor.upsert({
      where: {
        source_accountKey: {
          source: 'GOOGLE_DRIVE_CHANGES',
          accountKey: `${config.videoFolderId}:${config.thumbnailFolderId}`,
        },
      },
      create: {
        source: 'GOOGLE_DRIVE_CHANGES',
        accountKey: `${config.videoFolderId}:${config.thumbnailFolderId}`,
        cursor: assets.cursor,
      },
      update: { cursor: assets.cursor },
    });
    await audit(db, actorId, 'GOOGLE_DRIVE_SYNC_COMPLETED', {
      videosDiscovered: result.videosDiscovered,
      thumbnailsMatched: result.thumbnailsMatched,
      unmatchedThumbnails: result.unmatchedThumbnails,
    });
  } catch (error) {
    failures.push('drive');
    await audit(db, actorId, 'GOOGLE_DRIVE_SYNC_FAILED', {
      error: error instanceof Error ? error.message : 'Unknown Drive failure',
    });
  }

  await audit(db, actorId, 'GOOGLE_SHEET_SYNC_STARTED');
  try {
    const [sheetRows, settings] = await Promise.all([
      sheet.readVideoRows(config.spreadsheetId, 'Videos!A1:R10000'),
      sheet.readSettings(config.spreadsheetId),
    ]);
    result.sheetRowsRead = sheetRows.length;
    const resolvedSheetRows = await resolveSheetVideoIds(db, sheetRows);
    const reconciliation = await reconcileSheetRows(db, {
      spreadsheetId: config.spreadsheetId,
      actorId,
      rows: resolvedSheetRows.map(humanAndProtectedFields),
    });
    result.sheetRowsInvalid = reconciliation.invalid.length;
    result.sheetConflicts = reconciliation.results.reduce(
      (count, row) => count + row.conflicts.length,
      reconciliation.duplicateIds.length,
    );
    const importedSettings = await importSettings(db, settings, actorId);
    result.settingsApplied = importedSettings.applied;
    result.invalidSettings = importedSettings.invalid;

    const videos = await db.video.findMany({
      include: {
        thumbnail: true,
        schedule: true,
        postingHistory: true,
        content: { orderBy: { version: 'desc' }, take: 1 },
        publishAttempts: { orderBy: { createdAt: 'desc' } },
      },
      orderBy: { videoId: 'asc' },
    });
    const prepared: Array<{
      video: (typeof videos)[number];
      mirror: Awaited<ReturnType<typeof prepareSheetMirrorRow>>;
    }> = [];
    for (const video of videos) {
      try {
        prepared.push({ video, mirror: await prepareSheetMirrorRow(db, video.videoId) });
      } catch (error) {
        // A concurrent operator/test cleanup can remove a video after the list read.
        // Skip only that stale row; a later sync will reconcile any surviving data.
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025')
          continue;
        throw error;
      }
    }
    await sheet.mirrorVideoRows(
      config.spreadsheetId,
      prepared.map(({ video, mirror }) => ({
        videoId: video.videoId,
        videoLink: driveLink(video.driveFileId),
        thumbnailLink: driveLink(video.thumbnail?.driveFileId ?? null),
        status: mirror.workflowStatus,
        selectedDate: video.schedule?.businessDate ?? '',
        scheduledDate: video.schedule?.businessDate ?? '',
        scheduledTime: video.schedule
          ? `${String(video.schedule.slotHour).padStart(2, '0')}:00`
          : '',
        postedDate: video.postingHistory?.postedAt.toISOString() ?? '',
        instagramMediaId: mirror.instagramMediaId,
        instagramPermalink: mirror.permalink,
        caption: video.content[0]?.caption ?? '',
        hashtags: video.content[0]?.hashtags.join(' ') ?? '',
        error: video.publishAttempts[0]?.errorCode ?? '',
        retryCount: video.publishAttempts.length,
      })),
    );
    for (const { video, mirror } of prepared) {
      try {
        if (
          await recordSheetMirror(db, {
            spreadsheetId: config.spreadsheetId,
            videoId: video.videoId,
            rowVersion: mirror.rowVersion,
            contentHash: mirror.contentHash,
          })
        )
          result.rowsMirrored += 1;
      } catch (error) {
        // A video can be removed by an operator/test between the read and mirror
        // acknowledgement. The Sheet write is already complete, so skip only that
        // stale acknowledgement and let the next sync reconcile the row.
        if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025'))
          throw error;
      }
    }

    const historyRows: SheetPostingHistoryRow[] = videos.flatMap((video) => {
      const post = video.postingHistory;
      if (!post) return [];
      return [
        {
          date: post.businessDate,
          videoId: video.videoId,
          ...(video.faceId ? { faceId: video.faceId } : {}),
          ...(video.schedule
            ? { scheduledTime: `${String(video.schedule.slotHour).padStart(2, '0')}:00` }
            : {}),
          postedTime: post.postedAt.toISOString(),
          instagramMediaId: post.instagramMediaId,
          ...(post.permalink ? { permalink: post.permalink } : {}),
          result: 'POSTED',
        },
      ];
    });
    await sheet.mirrorPostingHistory(config.spreadsheetId, historyRows);
    result.postingHistoryMirrored = historyRows.length;
    await audit(db, actorId, 'GOOGLE_SHEET_SYNC_COMPLETED', {
      rowsRead: result.sheetRowsRead,
      rowsMirrored: result.rowsMirrored,
      conflicts: result.sheetConflicts,
    });
  } catch (error) {
    failures.push('sheet');
    await audit(db, actorId, 'GOOGLE_SHEET_SYNC_FAILED', {
      error: error instanceof Error ? error.message : 'Unknown Sheet failure',
    });
  }

  if (failures.length) throw new GoogleSyncRunError(failures, result);
  return result;
}
