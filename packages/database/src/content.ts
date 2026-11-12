import { createHash } from 'node:crypto';
import {
  deriveVideoReadiness,
  normalizeGeneratedContent,
  type ContentGenerationResult,
} from '@gcs/core';
import { Prisma, type PrismaClient } from '@prisma/client';

function generationFingerprint(parts: readonly unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

/** Match callbacks to the last generation started under the video's row lock. */
async function isCurrentGeneration(tx: Prisma.TransactionClient, videoId: string, key: string) {
  const started = await tx.auditLog.findFirst({
    where: {
      entity: 'Video',
      entityId: videoId,
      action: { in: ['CONTENT_GENERATION_STARTED', 'CONTENT_REGENERATION_STARTED'] },
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { after: true },
  });
  const after = started?.after;
  if (!after || typeof after !== 'object' || Array.isArray(after)) return false;
  const token = after['generationKey'];
  // Older starts recorded a 16-character prefix of the same SHA-256 key.
  return (
    typeof token === 'string' && (token === key || (token.length === 16 && key.startsWith(token)))
  );
}

async function enqueueMediaPreparation(
  tx: Prisma.TransactionClient,
  videoId: string,
  scheduleId: string,
  contentVersion: number,
) {
  const eventKey = `prepare:${scheduleId}:${contentVersion}`;
  await tx.outboxEvent.upsert({
    where: { eventKey },
    create: {
      eventKey,
      eventType: 'content.generated',
      payload: { videoId, scheduleId, contentVersion },
    },
    update: {},
  });
}

export interface ContentClaimInput {
  videoId: string;
  promptVersion: string;
  provider?: string;
  modelName: string;
  actorId: string;
  regenerate?: boolean;
  regenerationRequestId?: string;
}

export async function beginContentGeneration(db: PrismaClient, input: ContentClaimInput) {
  if (!input.actorId.trim() || !input.promptVersion.trim() || !input.modelName.trim())
    throw new Error('actorId, promptVersion and modelName are required');
  if (input.regenerate && !input.regenerationRequestId?.trim())
    throw new Error('regenerationRequestId is required for explicit regeneration');
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Video" WHERE "videoId" = ${input.videoId} FOR UPDATE`;
    const video = await tx.video.findUniqueOrThrow({
      where: { videoId: input.videoId },
      include: { face: true, thumbnail: true, schedule: true, postingHistory: true },
    });
    if (
      deriveVideoReadiness(video) !== 'READY' ||
      video.postingHistory ||
      (video.schedule && !['SELECTED', 'SCHEDULED'].includes(video.schedule.status))
    )
      throw new Error('Content generation requires approved title, face and video');
    if (
      !['READY', 'SELECTED', 'CONTENT_GENERATING', 'CONTENT_READY', 'SCHEDULED', 'FAILED'].includes(
        video.workflowStatus,
      )
    )
      throw new Error(`Content generation is not allowed from ${video.workflowStatus}`);
    const provider = input.provider ?? 'unknown';
    const base = [
      video.videoId,
      video.inputVersion,
      video.title,
      input.promptVersion,
      provider,
      input.modelName,
    ];
    const generationKey = generationFingerprint(
      input.regenerate ? [...base, 'regenerate', input.regenerationRequestId] : base,
    );
    const existing = await tx.content.findUnique({ where: { generationKey } });
    if (existing) {
      const schedule = await tx.schedule.findUnique({ where: { videoId: video.id } });
      if (schedule?.status === 'SELECTED' && video.workflowStatus === 'SELECTED') {
        await tx.video.update({
          where: { id: video.id },
          data: { workflowStatus: 'CONTENT_READY' },
        });
        await enqueueMediaPreparation(tx, video.videoId, schedule.id, existing.version);
      }
      return { reused: true as const, generationKey, video, content: existing };
    }
    await tx.video.update({
      where: { id: video.id },
      data: { workflowStatus: 'CONTENT_GENERATING' },
    });
    await tx.auditLog.create({
      data: {
        actorId: input.actorId,
        createdAt: new Date(),
        action: input.regenerate ? 'CONTENT_REGENERATION_STARTED' : 'CONTENT_GENERATION_STARTED',
        entity: 'Video',
        entityId: video.id,
        after: {
          promptVersion: input.promptVersion,
          provider,
          modelName: input.modelName,
          generationKey,
        },
      },
    });
    return { reused: false as const, generationKey, video, content: null };
  });
}

export async function completeContentGeneration(
  db: PrismaClient,
  input: {
    videoId: string;
    generationKey: string;
    promptVersion: string;
    provider: string;
    modelName: string;
    result: ContentGenerationResult;
    actorId: string;
    regenerated?: boolean;
  },
) {
  const normalized = normalizeGeneratedContent(input.result);
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Video" WHERE "videoId" = ${input.videoId} FOR UPDATE`;
    const video = await tx.video.findUniqueOrThrow({ where: { videoId: input.videoId } });
    const existing = await tx.content.findUnique({ where: { generationKey: input.generationKey } });
    if (existing) return existing;
    if (
      video.workflowStatus !== 'CONTENT_GENERATING' ||
      video.approvalStatus !== 'APPROVED' ||
      !(await isCurrentGeneration(tx, video.id, input.generationKey))
    )
      throw new Error('Content generation is no longer active');
    const latest = await tx.content.aggregate({
      where: { videoId: video.id },
      _max: { version: true },
    });
    const content = await tx.content.create({
      data: {
        videoId: video.id,
        version: (latest._max.version ?? 0) + 1,
        titleSnapshot: video.title ?? '',
        caption: normalized.caption,
        hashtags: normalized.hashtags,
        cta: normalized.cta,
        provider: input.provider,
        modelName: input.modelName,
        promptVersion: input.promptVersion,
        generationKey: input.generationKey,
        usage: input.result.usage ? (input.result.usage as Prisma.InputJsonValue) : Prisma.JsonNull,
        regenerated: input.regenerated ?? false,
      },
    });
    await tx.video.update({ where: { id: video.id }, data: { workflowStatus: 'CONTENT_READY' } });
    const schedule = await tx.schedule.findUnique({ where: { videoId: video.id } });
    if (schedule) await enqueueMediaPreparation(tx, video.videoId, schedule.id, content.version);
    await tx.auditLog.create({
      data: {
        actorId: input.actorId,
        action: input.regenerated ? 'CONTENT_REGENERATED' : 'CONTENT_GENERATION_COMPLETED',
        entity: 'Video',
        entityId: video.id,
        after: {
          contentVersion: content.version,
          promptVersion: input.promptVersion,
          provider: input.provider,
          modelName: input.modelName,
          usage: input.result.usage,
        },
      },
    });
    return content;
  });
}

export async function recordContentGenerationFailure(
  db: PrismaClient,
  input: {
    videoId: string;
    actorId: string;
    errorCode: string;
    retryable: boolean;
    classification: string;
    generationKey?: string;
    providerStatus?: number;
    providerType?: string;
    providerCode?: string;
    requestId?: string;
    retryAfterSeconds?: number;
  },
): Promise<void> {
  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Video" WHERE "videoId" = ${input.videoId} FOR UPDATE`;
    const video = await tx.video.findUniqueOrThrow({
      where: { videoId: input.videoId },
      include: {
        content: { orderBy: { version: 'desc' }, take: 1 },
        schedule: { select: { status: true } },
      },
    });
    if (
      video.workflowStatus !== 'CONTENT_GENERATING' ||
      (input.generationKey && !(await isCurrentGeneration(tx, video.id, input.generationKey)))
    )
      return;
    const latest = video.content[0];
    const usableContent =
      latest &&
      latest.titleSnapshot === video.title &&
      video.readyAt &&
      latest.createdAt >= video.readyAt;
    const recoveryStatus = usableContent
      ? video.schedule?.status === 'SCHEDULED'
        ? 'SCHEDULED'
        : 'CONTENT_READY'
      : video.schedule
        ? input.retryable
          ? 'SELECTED'
          : 'FAILED'
        : 'READY';
    await tx.video.update({
      where: { id: video.id },
      data: { workflowStatus: recoveryStatus },
    });
    await tx.auditLog.create({
      data: {
        actorId: input.actorId,
        action: 'CONTENT_GENERATION_FAILED',
        entity: 'Video',
        entityId: video.id,
        after: {
          errorCode: input.errorCode,
          classification: input.classification,
          retryable: input.retryable,
          ...(input.providerStatus !== undefined ? { providerStatus: input.providerStatus } : {}),
          ...(input.providerType ? { providerType: input.providerType } : {}),
          ...(input.providerCode ? { providerCode: input.providerCode } : {}),
          ...(input.requestId ? { requestId: input.requestId } : {}),
          ...(input.retryAfterSeconds !== undefined
            ? { retryAfterSeconds: input.retryAfterSeconds }
            : {}),
        },
      },
    });
  });
}

export async function markContentScheduled(db: PrismaClient, videoId: string, actorId: string) {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Video" WHERE "videoId" = ${videoId} FOR UPDATE`;
    const video = await tx.video.findUniqueOrThrow({
      where: { videoId },
      include: { schedule: true, content: { orderBy: { version: 'desc' }, take: 1 } },
    });
    if (!video.schedule || !video.content[0])
      throw new Error('Schedule and generated content are required');
    if (!['CONTENT_READY', 'SCHEDULED'].includes(video.workflowStatus))
      throw new Error(`Cannot schedule content from ${video.workflowStatus}`);
    if (video.workflowStatus === 'SCHEDULED' && video.schedule.status === 'SCHEDULED')
      return video.schedule;
    if (!['SELECTED', 'SCHEDULED'].includes(video.schedule.status))
      throw new Error('Schedule is no longer awaiting content');
    const schedule = await tx.schedule.update({
      where: { id: video.schedule.id },
      data: { status: 'SCHEDULED' },
    });
    await tx.video.update({ where: { id: video.id }, data: { workflowStatus: 'SCHEDULED' } });
    await tx.auditLog.create({
      data: {
        actorId,
        action: 'CONTENT_SCHEDULED',
        entity: 'Schedule',
        entityId: video.schedule.id,
        after: { videoId, jobId: video.schedule.jobId },
      },
    });
    return schedule;
  });
}
