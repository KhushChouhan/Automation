import { businessDateOf } from '@gcs/core';
import type { PrismaClient } from '@prisma/client';

const MEDIA_RETENTION_MS = 24 * 60 * 60_000;

export interface SuccessfulPostInput {
  videoId: string;
  publishAttemptId: string;
  instagramMediaId: string;
  permalink?: string;
  postedAt: Date;
}

/** Reconciliation is idempotent for the same media ID; a second media ID is forbidden. */
export async function recordSuccessfulPost(db: PrismaClient, input: SuccessfulPostInput) {
  if (!input.instagramMediaId.trim()) throw new Error('instagramMediaId is required');
  const businessDate = businessDateOf(input.postedAt);
  return db.$transaction(async (tx) => {
    // Serialize with claim/recovery before reading the attempt or terminal history.
    await tx.$queryRaw`SELECT "id" FROM "PublishAttempt" WHERE "id" = ${input.publishAttemptId} FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "Video" WHERE "videoId" = ${input.videoId} FOR UPDATE`;
    const video = await tx.video.findUniqueOrThrow({
      where: { videoId: input.videoId },
      include: { postingHistory: true, schedule: true },
    });
    const attempt = await tx.publishAttempt.findUniqueOrThrow({
      where: { id: input.publishAttemptId },
    });
    if (!video.schedule || attempt.videoId !== video.id || attempt.scheduleId !== video.schedule.id)
      throw new Error('Publish attempt does not match video schedule');
    if (video.postingHistory) {
      if (video.postingHistory.instagramMediaId !== input.instagramMediaId) {
        throw new Error(`Video ${input.videoId} already posted as another Instagram media ID`);
      }
      return video.postingHistory;
    }
    if (!video.faceId) throw new Error('Cannot record a post without a schedule and face');
    if (
      !['PUBLISH_REQUESTED', 'RECONCILE_REQUIRED'].includes(attempt.status) ||
      !attempt.containerId
    )
      throw new Error(`Cannot finalize a post from attempt status ${attempt.status}`);
    if (attempt.mediaId && attempt.mediaId !== input.instagramMediaId)
      throw new Error('Persisted media ID differs from the reconciled media ID');
    const post = await tx.postingHistory.create({
      data: {
        videoId: video.id,
        faceId: video.schedule.faceId,
        instagramMediaId: input.instagramMediaId,
        permalink: input.permalink ?? null,
        businessDate,
        postedAt: input.postedAt,
      },
    });
    await tx.publishAttempt.update({
      where: { id: attempt.id },
      data: {
        status: 'SUCCEEDED',
        mediaId: input.instagramMediaId,
        leaseToken: null,
        leaseExpiresAt: null,
      },
    });
    await tx.schedule.update({ where: { id: video.schedule.id }, data: { status: 'POSTED' } });
    await tx.video.update({ where: { id: video.id }, data: { workflowStatus: 'POSTED' } });
    await tx.outboxEvent.upsert({
      where: { eventKey: `sheet-mirror:${video.videoId}` },
      create: {
        eventKey: `sheet-mirror:${video.videoId}`,
        eventType: 'sheet.mirror',
        payload: { videoId: video.videoId, scheduleId: video.schedule.id },
      },
      update: {},
    });
    const mediaAsset = await tx.mediaAsset.findUnique({
      where: { scheduleId: video.schedule.id },
      select: { id: true },
    });
    if (mediaAsset) {
      await tx.outboxEvent.upsert({
        where: { eventKey: `cleanup:${mediaAsset.id}` },
        create: {
          eventKey: `cleanup:${mediaAsset.id}`,
          eventType: 'media.cleanup',
          payload: {
            assetId: mediaAsset.id,
            videoId: video.videoId,
            scheduleId: video.schedule.id,
          },
          availableAt: new Date(
            Math.max(Date.now(), input.postedAt.getTime()) + MEDIA_RETENTION_MS,
          ),
        },
        update: {},
      });
    }
    await tx.auditLog.create({
      data: {
        actorId: 'automation',
        action: 'VIDEO_POSTED',
        entity: 'Video',
        entityId: video.id,
        after: {
          instagramMediaId: input.instagramMediaId,
          businessDate,
          publishAttemptId: attempt.id,
        },
      },
    });
    return post;
  });
}
