import { permanentVideoIdSchema } from '@gcs/core';
import type { PrismaClient } from '@prisma/client';
import { recordSyncConflictInTransaction } from './sheet-sync.js';
import { attachThumbnailInTransaction } from './videos.js';

export interface DriveThumbnailAsset {
  fileId: string;
  name: string;
  mimeType?: string;
  checksum?: string;
  /** Explicit Drive metadata wins over a filename prefix. */
  videoId?: string;
}

export function candidateVideoId(asset: DriveThumbnailAsset): string | null {
  if (asset.videoId !== undefined) {
    const value = asset.videoId.trim();
    return permanentVideoIdSchema.safeParse(value).success ? value : null;
  }
  const match = /^(GCS-[0-9]{4,})(?:[._ -]|$)/i.exec(asset.name.trim());
  const value = match?.[1]?.toUpperCase();
  return value && permanentVideoIdSchema.safeParse(value).success ? value : null;
}

/** Associate only an unambiguous explicit Video ID. Unknown and competing files remain visible. */
export async function reconcileDriveThumbnails(
  db: PrismaClient,
  assets: readonly DriveThumbnailAsset[],
  actorId: string,
) {
  if (!actorId.trim()) throw new Error('actorId is required');
  const byFileId = new Map<string, DriveThumbnailAsset>();
  for (const asset of assets) {
    if (!asset.fileId.trim() || !asset.name.trim())
      throw new Error('Thumbnail fileId and name are required');
    byFileId.set(asset.fileId.trim(), asset);
  }
  const groups = new Map<string, DriveThumbnailAsset[]>();
  const unmatched: Array<{
    asset: DriveThumbnailAsset;
    candidateId: string | null;
    reason: string;
  }> = [];
  for (const asset of byFileId.values()) {
    const id = candidateVideoId(asset);
    if (!id) {
      unmatched.push({ asset, candidateId: null, reason: 'NO_EXPLICIT_VIDEO_ID' });
      continue;
    }
    const group = groups.get(id) ?? [];
    group.push(asset);
    groups.set(id, group);
  }
  const attached: string[] = [];
  const conflicts: string[] = [];
  for (const [videoId, group] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    group.sort((a, b) => a.fileId.localeCompare(b.fileId));
    if (group.length > 1) {
      unmatched.push(
        ...group.map((asset) => ({ asset, candidateId: videoId, reason: 'MULTIPLE_CANDIDATES' })),
      );
      conflicts.push(videoId);
      await db.$transaction(async (tx) => {
        const video = await tx.video.findUnique({ where: { videoId } });
        const previous = await tx.syncConflict.findFirst({
          where: {
            source: 'DRIVE_THUMBNAIL',
            sourceKey: videoId,
            field: 'thumbnail',
            reason: 'MULTIPLE_CANDIDATES',
            resolvedAt: null,
          },
        });
        await recordSyncConflictInTransaction(tx, {
          source: 'DRIVE_THUMBNAIL',
          sourceKey: videoId,
          videoId: video?.id,
          field: 'thumbnail',
          reason: 'MULTIPLE_CANDIDATES',
          incomingValue: group.map((asset) => asset.fileId).join(','),
        });
        if (!previous)
          await tx.auditLog.create({
            data: {
              actorId,
              action: 'THUMBNAIL_CONFLICT',
              entity: 'Video',
              entityId: video?.id ?? videoId,
              after: { reason: 'MULTIPLE_CANDIDATES', candidateCount: group.length },
            },
          });
      });
      continue;
    }
    const asset = group[0]!;
    const result = await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Video" WHERE "videoId" = ${videoId} FOR UPDATE`;
      const video = await tx.video.findUnique({
        where: { videoId },
        include: { thumbnail: true, schedule: true },
      });
      if (!video) return 'UNKNOWN_VIDEO';
      if (video.thumbnail?.driveFileId === asset.fileId) return 'ALREADY_ATTACHED';
      if (video.thumbnail || video.schedule || video.workflowStatus === 'POSTED') {
        await recordSyncConflictInTransaction(tx, {
          source: 'DRIVE_THUMBNAIL',
          sourceKey: videoId,
          videoId: video.id,
          field: 'thumbnail',
          reason: video.thumbnail ? 'EXISTING_THUMBNAIL' : 'VIDEO_LOCKED',
          databaseValue: video.thumbnail?.driveFileId,
          incomingValue: asset.fileId,
        });
        await tx.auditLog.create({
          data: {
            actorId,
            action: 'THUMBNAIL_CONFLICT',
            entity: 'Video',
            entityId: video.id,
            after: {
              reason: video.thumbnail ? 'EXISTING_THUMBNAIL' : 'VIDEO_LOCKED',
              driveFileId: asset.fileId,
            },
          },
        });
        return 'CONFLICT';
      }
      const other = await tx.thumbnail.findUnique({ where: { driveFileId: asset.fileId } });
      if (other) {
        await recordSyncConflictInTransaction(tx, {
          source: 'DRIVE_THUMBNAIL',
          sourceKey: videoId,
          videoId: video.id,
          field: 'thumbnail',
          reason: 'DRIVE_ID_ALREADY_LINKED',
          incomingValue: asset.fileId,
        });
        await tx.auditLog.create({
          data: {
            actorId,
            action: 'THUMBNAIL_CONFLICT',
            entity: 'Video',
            entityId: video.id,
            after: { reason: 'DRIVE_ID_ALREADY_LINKED', driveFileId: asset.fileId },
          },
        });
        return 'CONFLICT';
      }
      await attachThumbnailInTransaction(tx, videoId, asset.fileId, actorId);
      await tx.thumbnail.update({
        where: { videoId: video.id },
        data: { checksum: asset.checksum ?? null, mimeType: asset.mimeType ?? null },
      });
      await tx.unmatchedThumbnail.deleteMany({ where: { driveFileId: asset.fileId } });
      await tx.auditLog.create({
        data: {
          actorId,
          action: 'THUMBNAIL_MATCHED',
          entity: 'Video',
          entityId: video.id,
          after: { driveFileId: asset.fileId, videoId },
        },
      });
      return 'ATTACHED';
    });
    if (result === 'ATTACHED') attached.push(asset.fileId);
    else if (result === 'CONFLICT') {
      unmatched.push({ asset, candidateId: videoId, reason: 'CONFLICT' });
      conflicts.push(videoId);
    } else if (result === 'UNKNOWN_VIDEO') {
      unmatched.push({ asset, candidateId: videoId, reason: 'UNKNOWN_VIDEO' });
    }
  }
  for (const entry of unmatched) {
    await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${entry.asset.fileId}))`;
      const previous = await tx.unmatchedThumbnail.findUnique({
        where: { driveFileId: entry.asset.fileId },
      });
      const saved = await tx.unmatchedThumbnail.upsert({
        where: { driveFileId: entry.asset.fileId },
        update: {
          sourceName: entry.asset.name,
          checksum: entry.asset.checksum ?? null,
          mimeType: entry.asset.mimeType ?? null,
          candidateId: entry.candidateId,
          reason: entry.reason,
        },
        create: {
          driveFileId: entry.asset.fileId,
          sourceName: entry.asset.name,
          checksum: entry.asset.checksum ?? null,
          mimeType: entry.asset.mimeType ?? null,
          candidateId: entry.candidateId,
          reason: entry.reason,
        },
      });
      if (
        !previous ||
        previous.reason !== entry.reason ||
        previous.candidateId !== entry.candidateId
      ) {
        await tx.auditLog.create({
          data: {
            actorId,
            action: 'THUMBNAIL_DISCOVERED',
            entity: 'UnmatchedThumbnail',
            entityId: saved.id,
            after: {
              driveFileId: entry.asset.fileId,
              candidateId: entry.candidateId,
              reason: entry.reason,
            },
          },
        });
      }
    });
  }
  return {
    attached,
    unmatched: unmatched.map((entry) => entry.asset.fileId),
    conflicts: [...new Set(conflicts)],
  };
}
