import { createHash } from 'node:crypto';
import {
  approvalCommandSchema,
  sheetCommandValue,
  sheetHumanFields,
  sheetMirrorFields,
  sheetRowSchema,
  titleSchema,
  type SheetHumanField,
  type SheetRow,
} from '@gcs/core';
import { Prisma, type PrismaClient } from '@prisma/client';
import { decideApprovalInTransaction } from './approval.js';
import { assignFaceInTransaction, setVideoTitleInTransaction } from './videos.js';

type HumanSnapshot = Record<SheetHumanField, string | null>;

function hash(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(value) ?? 'undefined')
    .digest('hex');
}

function humanSnapshot(video: {
  title: string | null;
  faceId: string | null;
  face?: { id: string; name: string } | null;
  approvalStatus: string;
}): HumanSnapshot {
  return {
    title: video.title,
    faceId: video.face?.name ?? video.faceId,
    approvalStatus: video.approvalStatus,
  };
}

function savedSnapshot(value: Prisma.JsonValue): HumanSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid saved Sheet sync snapshot');
  const record = value as Record<string, unknown>;
  for (const field of sheetHumanFields) {
    if (record[field] !== null && typeof record[field] !== 'string')
      throw new Error('Invalid saved Sheet sync snapshot');
  }
  return {
    title: record['title'] as string | null,
    faceId: record['faceId'] as string | null,
    approvalStatus: record['approvalStatus'] as string,
  };
}

function incomingValue(row: SheetRow, field: SheetHumanField): string | undefined {
  if (field === 'approvalStatus')
    return row.approvalStatus === 'PENDING' ? undefined : row.approvalStatus;
  return sheetCommandValue(row[field]);
}

export async function recordSyncConflictInTransaction(
  tx: Prisma.TransactionClient,
  input: {
    source: string;
    sourceKey: string;
    videoId?: string | undefined;
    field: string;
    reason: string;
    databaseValue?: string | null | undefined;
    incomingValue?: string | null | undefined;
  },
) {
  const fingerprint = hash([
    input.source,
    input.sourceKey,
    input.field,
    input.reason,
    input.databaseValue ?? null,
    input.incomingValue ?? null,
  ]);
  return tx.syncConflict.upsert({
    where: { fingerprint },
    update: { resolvedAt: null },
    create: {
      source: input.source,
      sourceKey: input.sourceKey,
      videoId: input.videoId ?? null,
      field: input.field,
      reason: input.reason,
      fingerprint,
      databaseValue: input.databaseValue ?? Prisma.JsonNull,
      incomingValue: input.incomingValue ?? Prisma.JsonNull,
    },
  });
}

export interface SheetReconcileInput {
  spreadsheetId: string;
  row: unknown;
  actorId: string;
}

/** Validate the whole read before importing so duplicate Video IDs cannot choose a winner. */
export async function reconcileSheetRows(
  db: PrismaClient,
  input: { spreadsheetId: string; rows: readonly unknown[]; actorId: string },
) {
  const spreadsheetId = input.spreadsheetId.trim();
  if (!spreadsheetId || !input.actorId.trim())
    throw new Error('spreadsheetId and actorId are required');
  const valid: SheetRow[] = [];
  const invalid: string[] = [];
  for (const raw of input.rows) {
    const parsed = sheetRowSchema.safeParse(raw);
    if (parsed.success) valid.push(parsed.data);
    else {
      const key = `${spreadsheetId}:invalid:${hash(raw)}`;
      await db.$transaction((tx) =>
        recordSyncConflictInTransaction(tx, {
          source: 'SHEET',
          sourceKey: key,
          field: 'row',
          reason: 'INVALID_ROW',
        }),
      );
      invalid.push(key);
    }
  }
  const counts = new Map<string, number>();
  for (const row of valid) counts.set(row.videoId, (counts.get(row.videoId) ?? 0) + 1);
  const duplicateIds = [...counts]
    .filter(([, count]) => count > 1)
    .map(([id]) => id)
    .sort();
  for (const videoId of duplicateIds) {
    await db.$transaction(async (tx) => {
      const video = await tx.video.findUnique({ where: { videoId } });
      await recordSyncConflictInTransaction(tx, {
        source: 'SHEET',
        sourceKey: `${spreadsheetId}:${videoId}`,
        videoId: video?.id,
        field: 'videoId',
        reason: 'DUPLICATE_VIDEO_ID',
        incomingValue: String(counts.get(videoId)),
      });
    });
  }
  const results = [];
  for (const row of valid) {
    if ((counts.get(row.videoId) ?? 0) > 1) continue;
    results.push(await reconcileSheetRow(db, { spreadsheetId, row, actorId: input.actorId }));
  }
  return { results, duplicateIds, invalid };
}

/** Three-way merge of human columns. A Sheet row never creates a Video or changes system fields. */
export async function reconcileSheetRow(db: PrismaClient, input: SheetReconcileInput) {
  const spreadsheetId = input.spreadsheetId.trim();
  const actorId = input.actorId.trim();
  if (!spreadsheetId || !actorId) throw new Error('spreadsheetId and actorId are required');
  const row = sheetRowSchema.parse(input.row);
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Video" WHERE "videoId" = ${row.videoId} FOR UPDATE`;
    let video = await tx.video.findUnique({
      where: { videoId: row.videoId },
      include: { schedule: true, face: true, thumbnail: true },
    });
    if (!video) {
      await recordSyncConflictInTransaction(tx, {
        source: 'SHEET',
        sourceKey: `${spreadsheetId}:${row.videoId}`,
        field: 'videoId',
        reason: 'UNKNOWN_VIDEO',
        incomingValue: row.videoId,
      });
      return {
        videoId: row.videoId,
        applied: [] as SheetHumanField[],
        conflicts: ['videoId'],
        repairFields: [] as string[],
      };
    }
    const sourceKey = `${spreadsheetId}:${row.videoId}`;
    const state = await tx.sheetRowSync.findUnique({
      where: { spreadsheetId_videoId: { spreadsheetId, videoId: video.id } },
    });
    const baseline = state ? savedSnapshot(state.lastSyncedHuman) : humanSnapshot(video);
    const nextBaseline = { ...baseline };
    const applied: SheetHumanField[] = [];
    const conflicts: string[] = [];
    for (const field of sheetHumanFields) {
      const incoming = incomingValue(row, field);
      if (incoming === undefined) continue;
      const current = humanSnapshot(video)[field];
      const isFaceField = field === 'faceId';
      const isSameFace =
        isFaceField &&
        Boolean(incoming) &&
        (video.face?.name?.trim().toLowerCase() === String(incoming).trim().toLowerCase() ||
          video.faceId === incoming);
      const isSameValue = incoming === current || isSameFace;

      if (isSameValue) {
        nextBaseline[field] = current;
        await tx.syncConflict.updateMany({
          where: { source: 'SHEET', sourceKey, field, resolvedAt: null },
          data: { resolvedAt: new Date() },
        });
        continue;
      }
      let reason: string | null = null;
      if (!reason && !state && current !== null && current !== 'PENDING')
        reason = 'INITIAL_VALUE_DIFFERS';
      if (!reason && state && current !== baseline[field] && incoming !== baseline[field])
        reason = 'CONCURRENT_EDIT';
      if (!reason && state && incoming === baseline[field]) continue;
      if (!reason && (video.schedule || video.workflowStatus === 'POSTED')) reason = 'VIDEO_LOCKED';
      if (!reason && field === 'title' && !titleSchema.safeParse(incoming).success)
        reason = 'INVALID_TITLE';
      if (!reason && field === 'faceId') {
        const face =
          (await tx.face.findUnique({ where: { id: incoming } })) ??
          (await tx.face.findUnique({ where: { name: incoming } })) ??
          (await tx.face.create({ data: { name: incoming, active: true } }));
        if (!face?.active) reason = 'UNKNOWN_OR_INACTIVE_FACE';
      }
      if (!reason && field === 'approvalStatus') {
        const command = {
          decision: incoming,
          actorId,
          reason: sheetCommandValue(row.approvalReason),
        };
        if (!approvalCommandSchema.safeParse(command).success) reason = 'INVALID_APPROVAL';
        else if (incoming === 'APPROVED') {
          let thumb = await tx.thumbnail.findUnique({ where: { videoId: video.id } });
          if (!thumb && video.driveFileId) {
            thumb = await tx.thumbnail.upsert({
              where: { videoId: video.id },
              create: { videoId: video.id, driveFileId: video.driveFileId },
              update: {},
            });
          }
          const hasFace = applied.includes('faceId') || Boolean(video.faceId);
          const hasTitle = applied.includes('title') || Boolean(video.title);
          if (!video.driveFileId || !hasFace || !hasTitle || !thumb)
            reason = 'INCOMPLETE_APPROVAL';
        }
      }
      if (reason) {
        await recordSyncConflictInTransaction(tx, {
          source: 'SHEET',
          sourceKey,
          videoId: video.id,
          field,
          reason,
          databaseValue: current,
          incomingValue: incoming,
        });
        conflicts.push(field);
        continue;
      }
      if (field === 'title') await setVideoTitleInTransaction(tx, video.videoId, incoming, actorId);
      if (field === 'faceId') await assignFaceInTransaction(tx, video.videoId, incoming, actorId);
      if (field === 'approvalStatus') {
        await decideApprovalInTransaction(tx, video.videoId, {
          decision: incoming as 'APPROVED' | 'REJECTED' | 'CHANGES_REQUIRED',
          actorId,
          reason: sheetCommandValue(row.approvalReason),
        });
      }
      await tx.syncConflict.updateMany({
        where: { source: 'SHEET', sourceKey, field, resolvedAt: null },
        data: { resolvedAt: new Date() },
      });
      video = await tx.video.findUniqueOrThrow({
        where: { id: video.id },
        include: { schedule: true, face: true, thumbnail: true },
      });
      await tx.auditLog.create({
        data: {
          actorId,
          action:
            field === 'title'
              ? 'SHEET_TITLE_IMPORTED'
              : field === 'faceId'
                ? 'SHEET_FACE_IMPORTED'
                : 'APPROVAL_IMPORTED',
          entity: 'Video',
          entityId: video.id,
          after: { spreadsheetId, field, inputVersion: video.inputVersion },
        },
      });
      nextBaseline[field] = humanSnapshot(video)[field] ?? null;
      applied.push(field);
    }
    const thumbnail = await tx.thumbnail.findUnique({ where: { videoId: video.id } });
    const post = await tx.postingHistory.findUnique({ where: { videoId: video.id } });
    const mirror = mirrorValues(video, thumbnail, post);
    for (const field of sheetMirrorFields) {
      const supplied = row[field];
      if (supplied === undefined || String(supplied) === String(mirror[field] ?? '')) {
        await tx.syncConflict.updateMany({
          where: { source: 'SHEET_SYSTEM_FIELD', sourceKey, field, resolvedAt: null },
          data: { resolvedAt: new Date() },
        });
      }
    }
    const repairFields = sheetMirrorFields.filter((field) => {
      const supplied = row[field];
      return supplied !== undefined && String(supplied) !== String(mirror[field] ?? '');
    });
    for (const field of repairFields) {
      await recordSyncConflictInTransaction(tx, {
        source: 'SHEET_SYSTEM_FIELD',
        sourceKey,
        videoId: video.id,
        field,
        reason: 'SYSTEM_FIELD_MISMATCH',
        databaseValue: String(mirror[field] ?? ''),
        incomingValue: String(row[field] ?? ''),
      });
      await tx.auditLog.create({
        data: {
          actorId,
          action: 'SYNC_CONFLICT',
          entity: 'Video',
          entityId: video.id,
          after: { spreadsheetId, field, reason: 'SYSTEM_FIELD_MISMATCH' },
        },
      });
    }
    await tx.sheetRowSync.upsert({
      where: { spreadsheetId_videoId: { spreadsheetId, videoId: video.id } },
      create: {
        spreadsheetId,
        videoId: video.id,
        rowVersion: row.rowVersion ?? null,
        lastSyncedHuman: nextBaseline,
        lastImportedHash: hash(row),
      },
      update: {
        rowVersion: row.rowVersion ?? null,
        lastSyncedHuman: nextBaseline,
        lastImportedHash: hash(row),
      },
    });
    return { videoId: row.videoId, applied, conflicts, repairFields };
  });
}

type MirrorVideo = {
  videoId: string;
  title: string | null;
  faceId: string | null;
  approvalStatus: string;
  workflowStatus: string;
  inputVersion: number;
  driveFileId: string | null;
};
type MirrorThumbnail = { driveFileId: string | null } | null;
type MirrorPost = { instagramMediaId: string; permalink: string | null; postedAt: Date } | null;

function mirrorValues(video: MirrorVideo, thumbnail: MirrorThumbnail, post: MirrorPost) {
  return {
    workflowStatus: video.workflowStatus,
    inputVersion: video.inputVersion,
    driveFileId: video.driveFileId ?? '',
    thumbnailDriveFileId: thumbnail?.driveFileId ?? '',
    instagramMediaId: post?.instagramMediaId ?? '',
    permalink: post?.permalink ?? '',
    postedAt: post?.postedAt.toISOString() ?? '',
  };
}

function preparedMirrorRow(video: MirrorVideo, thumbnail: MirrorThumbnail, post: MirrorPost) {
  const values = {
    videoId: video.videoId,
    title: video.title ?? '',
    faceId: video.faceId ?? '',
    approvalStatus: video.approvalStatus,
    ...mirrorValues(video, thumbnail, post),
  };
  const contentHash = hash(values);
  return {
    ...values,
    rowVersion: `${video.inputVersion}:${contentHash.slice(0, 16)}`,
    contentHash,
  };
}

/** Prepare a deterministic DB-owned mirror row, including immutable post identifiers. */
export async function prepareSheetMirrorRow(db: PrismaClient, videoId: string) {
  const video = await db.video.findUniqueOrThrow({
    where: { videoId },
    include: { thumbnail: true, postingHistory: true },
  });
  return preparedMirrorRow(video, video.thumbnail, video.postingHistory);
}

/** Call only after the Sheet write succeeds; stale acknowledgements are rejected. */
export async function recordSheetMirror(
  db: PrismaClient,
  input: { spreadsheetId: string; videoId: string; rowVersion: string; contentHash: string },
) {
  if (!input.spreadsheetId.trim()) throw new Error('spreadsheetId is required');
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Video" WHERE "videoId" = ${input.videoId} FOR UPDATE`;
    const video = await tx.video.findUniqueOrThrow({
      where: { videoId: input.videoId },
      include: { thumbnail: true, postingHistory: true },
    });
    const prepared = preparedMirrorRow(video, video.thumbnail, video.postingHistory);
    if (prepared.rowVersion !== input.rowVersion || prepared.contentHash !== input.contentHash)
      return false;
    await tx.sheetRowSync.upsert({
      where: { spreadsheetId_videoId: { spreadsheetId: input.spreadsheetId, videoId: video.id } },
      create: {
        spreadsheetId: input.spreadsheetId,
        videoId: video.id,
        lastSyncedHuman: humanSnapshot(video),
        lastMirroredHash: input.contentHash,
        lastMirroredVersion: input.rowVersion,
      },
      update: { lastMirroredHash: input.contentHash, lastMirroredVersion: input.rowVersion },
    });
    return true;
  });
}
