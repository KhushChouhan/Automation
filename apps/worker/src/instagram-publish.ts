import type { AppConfig } from '@gcs/config';
import {
  claimScheduledPublish,
  markContainerRequested,
  markPublishContainerProcessing,
  markPublishRequested,
  notePublishReconciliationCheck,
  persistPublishMediaId,
  recordPublishContainer,
  recordSuccessfulPost,
  requirePublishReconciliation,
  type PrismaClient,
} from '@gcs/database';
import {
  MetaGraphInstagramPublisher,
  MetaPublishingDisabledError,
  type InstagramPublisher,
  type MediaStorage,
} from '@gcs/integrations';
import { UnrecoverableError, type Processor } from 'bullmq';
import { createMediaStorage } from './phase3.js';

type PublishJobData = Record<string, unknown>;

export type PublishProcessorResult =
  | { skipped: true; reason: string; metaRequests: 0 }
  | { posted: true; mediaId: string }
  | { waiting: true; containerId: string }
  | { reconciling: true; attemptId: string };

export interface InstagramPublishDependencies {
  publisher?: InstagramPublisher;
  storage?: MediaStorage;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim())
    throw new UnrecoverableError(`${name} is required`);
  return value;
}

function captionFor(content: { caption: string; hashtags: string[] }): string {
  return [content.caption, content.hashtags.join(' ')].filter(Boolean).join('\n\n');
}

function failureCode(error: unknown): string {
  if (error instanceof MetaPublishingDisabledError) return 'PUBLISHING_DISABLED';
  if (error instanceof Error && /timeout|network|fetch/i.test(error.message))
    return 'NETWORK_OR_TIMEOUT';
  return 'UNKNOWN_PROVIDER_ERROR';
}

async function holdForDisabledPublishing(
  db: PrismaClient,
  scheduleId: string,
): Promise<PublishProcessorResult> {
  const schedule = await db.schedule.findUnique({
    where: { id: scheduleId },
    include: { video: { select: { id: true, videoId: true, manualActionReason: true } } },
  });
  if (!schedule) return { skipped: true, reason: 'Schedule not found', metaRequests: 0 };

  if (schedule.video.manualActionReason !== 'READY_FOR_PUBLISH_META_DISABLED') {
    await db.$transaction(async (tx) => {
      await tx.video.update({
        where: { id: schedule.video.id },
        data: {
          manualActionRequired: true,
          manualActionReason: 'READY_FOR_PUBLISH_META_DISABLED',
        },
      });
      await tx.auditLog.create({
        data: {
          actorId: 'publish-safety-gate',
          action: 'PUBLISH_READY_HELD',
          entity: 'Schedule',
          entityId: schedule.id,
          after: {
            videoId: schedule.video.videoId,
            scheduledAtUtc: schedule.scheduledAt.toISOString(),
            metaEnabled: false,
          },
        },
      });
    });
  }
  return { skipped: true, reason: 'Meta publishing is disabled', metaRequests: 0 };
}

async function loadPublishContext(db: PrismaClient, scheduleId: string) {
  const schedule = await db.schedule.findUniqueOrThrow({
    where: { id: scheduleId },
    include: {
      mediaAsset: true,
      video: { include: { content: { orderBy: { version: 'desc' }, take: 1 } } },
    },
  });
  const content = schedule.video.content[0];
  if (!schedule.mediaAsset || !content)
    throw new UnrecoverableError(
      'Scheduled publish is missing prepared media or generated content',
    );
  return { schedule, content };
}

/**
 * Gated orchestration only.  It intentionally performs no Meta request while the
 * deployment flag is false; that invariant is checked before a claim or adapter call.
 */
export function createInstagramPublishProcessors(
  db: PrismaClient,
  config: AppConfig,
  dependencies: InstagramPublishDependencies = {},
): {
  publish: Processor<PublishJobData, PublishProcessorResult>;
  reconcile: Processor<PublishJobData, PublishProcessorResult>;
} {
  const publisher =
    dependencies.publisher ??
    new MetaGraphInstagramPublisher({
      graphApiVersion: config.meta.graphApiVersion,
      authPath: config.meta.authPath,
      pageId: config.meta.pageId,
      pageAccessToken: config.meta.pageAccessToken,
      timeoutMs: config.meta.timeoutMs,
      tokenExpiresAt: config.meta.tokenExpiresAt,
      accessToken: config.meta.accessToken,
      instagramAccountId: config.meta.instagramAccountId,
      publishingEnabled: config.meta.publishingEnabled,
    });

  const reconcileAttempt = async (attemptId: string): Promise<PublishProcessorResult> => {
    const attempt = await db.publishAttempt.findUniqueOrThrow({
      where: { id: attemptId },
      include: { schedule: { include: { video: true } } },
    });
    if (!config.meta.publishingEnabled) return holdForDisabledPublishing(db, attempt.scheduleId);
    if (!attempt.containerId) {
      await notePublishReconciliationCheck(db, {
        attemptId,
        actorId: 'publish-reconcile-worker',
        outcome: 'CONTAINER_ID_MISSING',
      });
      return { reconciling: true, attemptId };
    }
    const published = await publisher.reconcilePublish(
      attempt.containerId,
      attempt.mediaId ?? undefined,
    );
    await notePublishReconciliationCheck(db, {
      attemptId,
      actorId: 'publish-reconcile-worker',
      outcome: published ? 'PROVIDER_MEDIA_FOUND' : 'PROVIDER_RESULT_PENDING',
    });
    if (!published) return { reconciling: true, attemptId };
    await recordSuccessfulPost(db, {
      videoId: attempt.schedule.video.videoId,
      publishAttemptId: attempt.id,
      instagramMediaId: published.mediaId,
      ...(published.permalink ? { permalink: published.permalink } : {}),
      postedAt: new Date(),
    });
    return { posted: true, mediaId: published.mediaId };
  };

  const reconcile: Processor<PublishJobData, PublishProcessorResult> = async (job) =>
    reconcileAttempt(requiredString(job.data['attemptId'], 'attemptId'));

  const publish: Processor<PublishJobData, PublishProcessorResult> = async (job) => {
    const scheduleId = requiredString(job.data['scheduleId'], 'scheduleId');
    if (!config.meta.publishingEnabled) return holdForDisabledPublishing(db, scheduleId);

    const claim = await claimScheduledPublish(db, {
      scheduleId,
      actorId: 'instagram-publish-worker',
    });
    if (claim.kind === 'POSTED')
      return { skipped: true, reason: 'Schedule is already posted', metaRequests: 0 };
    if (claim.kind === 'BUSY')
      return { skipped: true, reason: 'Schedule is leased by another worker', metaRequests: 0 };
    if (claim.kind === 'RECONCILE_REQUIRED') return reconcileAttempt(claim.attempt.id);

    const { schedule, content } = await loadPublishContext(db, scheduleId);
    const storage = dependencies.storage ?? createMediaStorage(config);
    const sourceObject = await storage.head(schedule.mediaAsset!.videoObjectKey);
    if (!sourceObject)
      throw new UnrecoverableError('Prepared Cloudinary media object is no longer available');
    if (!sourceObject.contentType.startsWith('video/') || sourceObject.sizeBytes <= 0)
      throw new UnrecoverableError('Prepared media object is not a valid video');
    // This signed URL is deliberately short-lived and kept in-memory only. It is never persisted
    // or logged, and regenerating it does not create a new Cloudinary object.
    const source = await storage.createReadUrl(
      schedule.mediaAsset!.videoObjectKey,
      config.meta.deliveryUrlTtlSeconds,
    );
    let containerId = claim.attempt.containerId;
    let containerRequestStarted = false;
    try {
      if (!containerId) {
        const containerRequest = await markContainerRequested(db, {
          attemptId: claim.attempt.id,
          leaseToken: claim.leaseToken,
          actorId: 'instagram-publish-worker',
        });
        containerRequestStarted = true;
        if (!containerRequest.shouldSend) {
          await requirePublishReconciliation(db, {
            attemptId: claim.attempt.id,
            leaseToken: claim.leaseToken,
            actorId: 'instagram-publish-worker',
            reason: 'CONTAINER_CREATE_OUTCOME_UNCERTAIN',
          });
          return { reconciling: true, attemptId: claim.attempt.id };
        }
        const created = await publisher.createReelContainer({
          videoUrl: source.url,
          caption: captionFor(content),
        });
        containerId = created.containerId;
        await recordPublishContainer(db, {
          attemptId: claim.attempt.id,
          leaseToken: claim.leaseToken,
          containerId,
          actorId: 'instagram-publish-worker',
        });
      }

      await markPublishContainerProcessing(db, {
        attemptId: claim.attempt.id,
        leaseToken: claim.leaseToken,
      });
      const status = await publisher.getContainerStatus(containerId);
      if (status.status === 'IN_PROGRESS') return { waiting: true, containerId };
      if (status.status !== 'FINISHED') {
        await requirePublishReconciliation(db, {
          attemptId: claim.attempt.id,
          leaseToken: claim.leaseToken,
          actorId: 'instagram-publish-worker',
          reason: 'CONTAINER_NOT_READY',
        });
        return { reconciling: true, attemptId: claim.attempt.id };
      }

      const request = await markPublishRequested(db, {
        attemptId: claim.attempt.id,
        leaseToken: claim.leaseToken,
        actorId: 'instagram-publish-worker',
      });
      if (!request.shouldSend) return { reconciling: true, attemptId: claim.attempt.id };
      const published = await publisher.publishContainer(containerId);
      await persistPublishMediaId(db, {
        attemptId: claim.attempt.id,
        leaseToken: claim.leaseToken,
        mediaId: published.mediaId,
        actorId: 'instagram-publish-worker',
      });
      const media = await publisher.getPublishedMedia(published.mediaId);
      await recordSuccessfulPost(db, {
        videoId: schedule.video.videoId,
        publishAttemptId: claim.attempt.id,
        instagramMediaId: media.mediaId,
        ...(media.permalink ? { permalink: media.permalink } : {}),
        postedAt: new Date(),
      });
      return { posted: true, mediaId: media.mediaId };
    } catch (error) {
      // Once a container exists the exact provider outcome is unknown on every error.
      // Persist reconciliation rather than ever issuing a second publish request.
      if (containerId || containerRequestStarted) {
        await requirePublishReconciliation(db, {
          attemptId: claim.attempt.id,
          leaseToken: claim.leaseToken,
          actorId: 'instagram-publish-worker',
          reason: containerId ? failureCode(error) : 'CONTAINER_CREATE_OUTCOME_UNCERTAIN',
        }).catch(() => undefined);
      }
      throw error;
    }
  };

  return { publish, reconcile };
}
