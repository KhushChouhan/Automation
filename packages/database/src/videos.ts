import { deriveWorkflowStatus, formatVideoId, titleSchema } from '@gcs/core';
import { Prisma, type PrismaClient } from '@prisma/client';

type Transaction = Prisma.TransactionClient;

/** Monotonic allocation is committed with the new Video row by the caller. */
export async function allocateVideoId(tx: Transaction): Promise<string> {
  const rows = await tx.$queryRaw<Array<{ value: bigint }>>`
    INSERT INTO "IdCounter" ("name", "value") VALUES ('video', 1)
    ON CONFLICT ("name") DO UPDATE SET "value" = "IdCounter"."value" + 1
    RETURNING "value"
  `;
  if (!rows[0]) throw new Error('Video ID allocation returned no value');
  return formatVideoId(rows[0].value);
}

export interface DiscoverVideoInput {
  driveFileId: string;
  sourceName?: string;
  sourceMimeType?: string;
  sourceChecksum?: string;
  sourceSizeBytes?: bigint | number | string;
  sourceCreatedTime?: Date | string;
  sourceModifiedTime?: Date | string;
}

function parseSize(value: DiscoverVideoInput['sourceSizeBytes']): bigint | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'number' && !Number.isSafeInteger(value))
    throw new Error('sourceSizeBytes must be a safe integer or decimal string');
  if (typeof value === 'string' && !/^[0-9]+$/.test(value))
    throw new Error('sourceSizeBytes must be a nonnegative integer');
  const size = BigInt(value);
  if (size < 0n || size > 9223372036854775807n)
    throw new Error('sourceSizeBytes is outside the PostgreSQL BIGINT range');
  return size;
}

function parseTimestamp(value: Date | string | undefined, field: string): Date | undefined {
  if (value === undefined) return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error(`${field} must be a valid timestamp`);
  return parsed;
}

/** Repeated Drive discoveries keep the original permanent ID. */
export async function discoverVideo(db: PrismaClient, input: DiscoverVideoInput) {
  const driveFileId = input.driveFileId.trim();
  if (!driveFileId) throw new Error('driveFileId is required');
  const sourceSizeBytes = parseSize(input.sourceSizeBytes);
  const sourceCreatedTime = parseTimestamp(input.sourceCreatedTime, 'sourceCreatedTime');
  const sourceModifiedTime = parseTimestamp(input.sourceModifiedTime, 'sourceModifiedTime');
  const existing = await db.video.findUnique({ where: { driveFileId } });
  if (existing) return existing;
  try {
    return await db.$transaction(async (tx) => {
      const videoId = await allocateVideoId(tx);
      const video = await tx.video.create({
        data: {
          videoId,
          driveFileId,
          sourceName: input.sourceName ?? null,
          sourceMimeType: input.sourceMimeType ?? null,
          sourceChecksum: input.sourceChecksum ?? null,
          sourceSizeBytes: sourceSizeBytes ?? null,
          sourceCreatedTime: sourceCreatedTime ?? null,
          sourceModifiedTime: sourceModifiedTime ?? null,
          workflowStatus: 'WAITING_FACE',
        },
      });
      await tx.auditLog.createMany({
        data: [
          {
            actorId: 'google-drive-sync',
            action: 'VIDEO_ID_ASSIGNED',
            entity: 'Video',
            entityId: video.id,
            after: { videoId },
          },
          {
            actorId: 'google-drive-sync',
            action: 'VIDEO_DISCOVERED',
            entity: 'Video',
            entityId: video.id,
            after: { videoId, driveFileId },
          },
        ],
      });
      return video;
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const raced = await db.video.findUnique({ where: { driveFileId } });
      if (raced) return raced;
    }
    throw error;
  }
}

export async function setVideoTitle(
  db: PrismaClient,
  videoId: string,
  title: string,
  actorId: string,
) {
  const validTitle = titleSchema.parse(title);
  if (!actorId.trim()) throw new Error('actorId is required');
  return db.$transaction((tx) => setVideoTitleInTransaction(tx, videoId, validTitle, actorId));
}

export async function setVideoTitleInTransaction(
  tx: Transaction,
  videoId: string,
  title: string,
  actorId: string,
) {
  const validTitle = titleSchema.parse(title);
  if (!actorId.trim()) throw new Error('actorId is required');
  await tx.$queryRaw`SELECT "id" FROM "Video" WHERE "videoId" = ${videoId} FOR UPDATE`;
  const before = await tx.video.findUniqueOrThrow({
    where: { videoId },
    include: { thumbnail: true, schedule: true },
  });
  if (before.workflowStatus === 'POSTED' || before.schedule)
    throw new Error('A selected or posted video title cannot be changed');
  const workflowStatus = deriveWorkflowStatus({
    hasVideo: Boolean(before.driveFileId),
    faceId: before.faceId,
    title: validTitle,
    hasThumbnail: Boolean(before.thumbnail),
    approvalStatus: 'PENDING',
  });
  const after = await tx.video.update({
    where: { videoId },
    data: {
      title: validTitle,
      approvalStatus: 'PENDING',
      workflowStatus,
      readyAt: null,
      inputVersion: { increment: 1 },
    },
  });
  await tx.auditLog.create({
    data: {
      actorId,
      action: 'VIDEO_TITLE_CHANGED',
      entity: 'Video',
      entityId: after.id,
      before: { title: before.title },
      after: { title: after.title },
    },
  });
  return after;
}

export async function assignFace(
  db: PrismaClient,
  videoId: string,
  faceId: string,
  actorId: string,
) {
  if (!actorId.trim()) throw new Error('actorId is required');
  return db.$transaction((tx) => assignFaceInTransaction(tx, videoId, faceId, actorId));
}

export async function assignFaceInTransaction(
  tx: Transaction,
  videoId: string,
  faceId: string,
  actorId: string,
) {
  if (!actorId.trim()) throw new Error('actorId is required');
  await tx.$queryRaw`SELECT "id" FROM "Video" WHERE "videoId" = ${videoId} FOR UPDATE`;
  const before = await tx.video.findUniqueOrThrow({
    where: { videoId },
    include: { thumbnail: true, schedule: true },
  });
  if (before.schedule || before.workflowStatus === 'POSTED')
    throw new Error('A selected or posted video face cannot be changed');
  const face = await tx.face.findUniqueOrThrow({ where: { id: faceId } });
  if (!face.active) throw new Error('Inactive face cannot be assigned');
  if (before.faceId === faceId) return before;
  const workflowStatus = deriveWorkflowStatus({
    hasVideo: Boolean(before.driveFileId),
    faceId,
    title: before.title,
    hasThumbnail: Boolean(before.thumbnail),
    approvalStatus: 'PENDING',
  });
  const after = await tx.video.update({
    where: { id: before.id },
    data: {
      faceId,
      approvalStatus: 'PENDING',
      workflowStatus,
      readyAt: null,
      inputVersion: { increment: 1 },
    },
  });
  await tx.auditLog.create({
    data: {
      actorId,
      action: 'VIDEO_FACE_ASSIGNED',
      entity: 'Video',
      entityId: before.id,
      before: { faceId: before.faceId },
      after: { faceId },
    },
  });
  return after;
}

export async function attachThumbnail(
  db: PrismaClient,
  videoId: string,
  driveFileId: string,
  actorId: string,
) {
  if (!driveFileId.trim() || !actorId.trim())
    throw new Error('driveFileId and actorId are required');
  return db.$transaction((tx) => attachThumbnailInTransaction(tx, videoId, driveFileId, actorId));
}

export async function attachThumbnailInTransaction(
  tx: Transaction,
  videoId: string,
  driveFileId: string,
  actorId: string,
) {
  if (!driveFileId.trim() || !actorId.trim())
    throw new Error('driveFileId and actorId are required');
  await tx.$queryRaw`SELECT "id" FROM "Video" WHERE "videoId" = ${videoId} FOR UPDATE`;
  const before = await tx.video.findUniqueOrThrow({
    where: { videoId },
    include: { thumbnail: true, schedule: true },
  });
  if (before.schedule || before.workflowStatus === 'POSTED')
    throw new Error('A selected or posted video thumbnail cannot be changed');
  if (before.thumbnail?.driveFileId === driveFileId) return before;
  await tx.thumbnail.upsert({
    where: { videoId: before.id },
    create: { videoId: before.id, driveFileId },
    update: { driveFileId },
  });
  const workflowStatus = deriveWorkflowStatus({
    hasVideo: Boolean(before.driveFileId),
    faceId: before.faceId,
    title: before.title,
    hasThumbnail: true,
    approvalStatus: 'PENDING',
  });
  const after = await tx.video.update({
    where: { id: before.id },
    data: {
      approvalStatus: 'PENDING',
      workflowStatus,
      readyAt: null,
      inputVersion: { increment: 1 },
    },
  });
  await tx.auditLog.create({
    data: {
      actorId,
      action: 'VIDEO_THUMBNAIL_ATTACHED',
      entity: 'Video',
      entityId: before.id,
      before: { driveFileId: before.thumbnail?.driveFileId ?? null },
      after: { driveFileId },
    },
  });
  return after;
}
