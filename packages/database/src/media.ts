import type { PrismaClient } from '@prisma/client';

export function mediaObjectKeys(videoId: string, scheduleId: string) {
  const clean = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, '_');
  const prefix = `reels/${clean(videoId)}/${clean(scheduleId)}`;
  return { video: `${prefix}/video.mp4`, thumbnail: `${prefix}/thumbnail.jpg` };
}

export async function beginMediaPreparation(
  db: PrismaClient,
  input: { videoId: string; provider: string; bucket?: string; actorId: string },
) {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Video" WHERE "videoId" = ${input.videoId} FOR UPDATE`;
    const video = await tx.video.findUniqueOrThrow({
      where: { videoId: input.videoId },
      include: {
        schedule: true,
        thumbnail: true,
        content: { orderBy: { version: 'desc' }, take: 1 },
      },
    });
    if (!video.schedule || !video.driveFileId || !video.content[0])
      throw new Error('Scheduled video, source Drive file and generated content are required');
    if (!['CONTENT_READY', 'SCHEDULED'].includes(video.workflowStatus))
      throw new Error(`Media preparation is not allowed from ${video.workflowStatus}`);
    const keys = mediaObjectKeys(video.videoId, video.schedule.id);
    const existing = await tx.mediaAsset.findUnique({ where: { scheduleId: video.schedule.id } });
    if (existing?.status === 'READY')
      return { reused: true as const, asset: existing, video, keys };
    const asset = await tx.mediaAsset.upsert({
      where: { scheduleId: video.schedule.id },
      create: {
        videoId: video.id,
        scheduleId: video.schedule.id,
        provider: input.provider,
        bucket: input.bucket ?? null,
        videoObjectKey: keys.video,
        thumbnailObjectKey: video.thumbnail ? keys.thumbnail : null,
        contentType: video.sourceMimeType ?? 'video/mp4',
        sizeBytes: video.sourceSizeBytes ?? 0,
        status: 'PREPARING',
      },
      update: {
        provider: input.provider,
        bucket: input.bucket ?? null,
        videoObjectKey: keys.video,
        thumbnailObjectKey: video.thumbnail ? keys.thumbnail : null,
        contentType: video.sourceMimeType ?? 'video/mp4',
        sizeBytes: video.sourceSizeBytes ?? 0,
        status: 'PREPARING',
        lastError: null,
      },
    });
    await tx.auditLog.create({
      data: {
        actorId: input.actorId,
        action: 'MEDIA_PREPARATION_STARTED',
        entity: 'Schedule',
        entityId: video.schedule.id,
        after: { videoId: video.videoId, provider: input.provider },
      },
    });
    return { reused: false as const, asset, video, keys };
  });
}

export async function completeMediaPreparation(
  db: PrismaClient,
  input: {
    scheduleId: string;
    sizeBytes: bigint;
    checksum?: string;
    expiresAt: Date;
    actorId: string;
  },
) {
  return db.$transaction(async (tx) => {
    const asset = await tx.mediaAsset.update({
      where: { scheduleId: input.scheduleId },
      data: {
        status: 'READY',
        sizeBytes: input.sizeBytes,
        checksum: input.checksum ?? null,
        expiresAt: input.expiresAt,
        preparedAt: new Date(),
        lastError: null,
      },
    });
    await tx.schedule.update({ where: { id: input.scheduleId }, data: { status: 'SCHEDULED' } });
    await tx.video.update({ where: { id: asset.videoId }, data: { workflowStatus: 'SCHEDULED' } });
    const schedule = await tx.schedule.findUniqueOrThrow({ where: { id: input.scheduleId } });
    const video = await tx.video.findUniqueOrThrow({ where: { id: asset.videoId } });
    await tx.outboxEvent.upsert({
      where: { eventKey: `ready:${schedule.jobId}` },
      create: {
        eventKey: `ready:${schedule.jobId}`,
        eventType: 'media.prepared',
        payload: {
          videoId: video.videoId,
          scheduleId: schedule.id,
          scheduledAtUtc: schedule.scheduledAt.toISOString(),
        },
      },
      update: {},
    });
    await tx.auditLog.create({
      data: {
        actorId: input.actorId,
        action: 'MEDIA_PREPARATION_COMPLETED',
        entity: 'Schedule',
        entityId: input.scheduleId,
        after: {
          provider: asset.provider,
          objectKey: asset.videoObjectKey,
          sizeBytes: String(input.sizeBytes),
        },
      },
    });
    return asset;
  });
}

export async function failMediaPreparation(
  db: PrismaClient,
  input: { scheduleId: string; errorCode: string; actorId: string },
): Promise<void> {
  await db.$transaction(async (tx) => {
    const asset = await tx.mediaAsset.update({
      where: { scheduleId: input.scheduleId },
      data: { status: 'FAILED', lastError: input.errorCode },
    });
    await tx.auditLog.create({
      data: {
        actorId: input.actorId,
        action: 'MEDIA_PREPARATION_FAILED',
        entity: 'Schedule',
        entityId: input.scheduleId,
        after: { errorCode: input.errorCode, provider: asset.provider },
      },
    });
  });
}

export async function markMediaCleaned(db: PrismaClient, scheduleId: string, actorId: string) {
  return db.$transaction(async (tx) => {
    const asset = await tx.mediaAsset.update({
      where: { scheduleId },
      data: { status: 'CLEANED', cleanedAt: new Date() },
    });
    await tx.auditLog.create({
      data: { actorId, action: 'MEDIA_CLEANED', entity: 'Schedule', entityId: scheduleId },
    });
    return asset;
  });
}
