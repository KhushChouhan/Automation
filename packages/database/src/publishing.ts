import { deriveVideoReadiness } from '@gcs/core';
import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient, PublishAttempt } from '@prisma/client';

const LEASE_MS = 15 * 60_000;

type Tx = Prisma.TransactionClient;

function requireActor(actorId: string): void {
  if (!actorId.trim()) throw new Error('actorId is required');
}

function requireEvidenceCode(value: string): void {
  if (!/^[A-Z0-9_]{3,120}$/.test(value))
    throw new Error('Reconciliation evidence must be a short machine code');
}

function assertLease(attempt: PublishAttempt, leaseToken: string): void {
  if (!leaseToken || attempt.leaseToken !== leaseToken)
    throw new Error('Publish attempt lease is no longer owned by this worker');
}

async function lockAttempt(tx: Tx, attemptId: string): Promise<PublishAttempt> {
  await tx.$queryRaw`SELECT "id" FROM "PublishAttempt" WHERE "id" = ${attemptId} FOR UPDATE`;
  return tx.publishAttempt.findUniqueOrThrow({ where: { id: attemptId } });
}

async function flagForReconciliation(
  tx: Tx,
  attempt: PublishAttempt,
  actorId: string,
  reason: string,
) {
  const updated = await tx.publishAttempt.update({
    where: { id: attempt.id },
    data: {
      status: 'RECONCILE_REQUIRED',
      reconcileRequiredAt: attempt.reconcileRequiredAt ?? new Date(),
      leaseToken: null,
      leaseExpiresAt: null,
      errorCode: reason.slice(0, 120),
    },
  });
  await tx.schedule.update({
    where: { id: attempt.scheduleId },
    data: { status: 'RECONCILE_REQUIRED' },
  });
  await tx.video.update({
    where: { id: attempt.videoId },
    data: { workflowStatus: 'RECONCILE_REQUIRED' },
  });
  const video = await tx.video.findUniqueOrThrow({
    where: { id: attempt.videoId },
    select: { videoId: true },
  });
  await tx.outboxEvent.upsert({
    where: { eventKey: `reconcile:${attempt.id}` },
    create: {
      eventKey: `reconcile:${attempt.id}`,
      eventType: 'publish.reconcile',
      payload: { attemptId: attempt.id, scheduleId: attempt.scheduleId, videoId: video.videoId },
    },
    update: {},
  });
  if (attempt.status !== 'RECONCILE_REQUIRED')
    await tx.auditLog.create({
      data: {
        actorId,
        action: 'PUBLISH_RECONCILIATION_REQUIRED',
        entity: 'PublishAttempt',
        entityId: attempt.id,
        after: { reason, scheduleId: attempt.scheduleId },
      },
    });
  return updated;
}

export type PublishClaim =
  | { kind: 'POSTED'; attempt: PublishAttempt | null }
  | { kind: 'BUSY'; attempt: PublishAttempt }
  | { kind: 'RECONCILE_REQUIRED'; attempt: PublishAttempt }
  | { kind: 'CLAIMED' | 'RESUMED'; attempt: PublishAttempt; leaseToken: string };

/** One transaction decides whether the prepared schedule may enter publishing. */
export async function claimScheduledPublish(
  db: PrismaClient,
  input: { scheduleId: string; actorId: string; now?: Date },
): Promise<PublishClaim> {
  requireActor(input.actorId);
  const now = input.now ?? new Date();
  return db.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Schedule" WHERE "id" = ${input.scheduleId} FOR UPDATE`;
      const schedule = await tx.schedule.findUniqueOrThrow({
        where: { id: input.scheduleId },
        include: {
          video: {
            include: {
              face: true,
              thumbnail: true,
              postingHistory: true,
              content: { orderBy: { version: 'desc' }, take: 1 },
            },
          },
          mediaAsset: true,
        },
      });
      const existing = await tx.publishAttempt.findFirst({
        where: { scheduleId: schedule.id },
        orderBy: { createdAt: 'desc' },
      });
      if (
        schedule.video.postingHistory ||
        schedule.status === 'POSTED' ||
        schedule.video.workflowStatus === 'POSTED'
      )
        return { kind: 'POSTED', attempt: existing };
      if (existing) {
        if (existing.status === 'SUCCEEDED')
          return {
            kind: 'RECONCILE_REQUIRED',
            attempt: await flagForReconciliation(
              tx,
              existing,
              input.actorId,
              'SUCCESS_WITHOUT_POSTING_HISTORY',
            ),
          };
        if (existing.status === 'RECONCILE_REQUIRED')
          return { kind: 'RECONCILE_REQUIRED', attempt: existing };
        if (existing.leaseExpiresAt && existing.leaseExpiresAt > now)
          return { kind: 'BUSY', attempt: existing };
        if (
          existing.status === 'PUBLISH_REQUESTED' ||
          existing.mediaId ||
          (existing.status === 'CLAIMED' && existing.containerRequestedAt)
        )
          return {
            kind: 'RECONCILE_REQUIRED',
            attempt: await flagForReconciliation(
              tx,
              existing,
              input.actorId,
              existing.containerRequestedAt && !existing.containerId
                ? 'CONTAINER_CREATE_OUTCOME_UNCERTAIN'
                : 'PUBLISH_OUTCOME_UNCERTAIN',
            ),
          };
        if (existing.status === 'FAILED')
          throw new Error('Failed publish attempt requires an explicit safe retry decision');
      }
      if (now < schedule.scheduledAt) throw new Error('Scheduled publish slot has not arrived');
      const expectedStatus = existing ? 'PUBLISHING' : 'SCHEDULED';
      if (schedule.status !== expectedStatus || schedule.video.workflowStatus !== expectedStatus)
        throw new Error('Publish claim requires a scheduled video in the expected workflow state');
      if (deriveVideoReadiness(schedule.video) !== 'READY' || !schedule.video.content[0])
        throw new Error('Publish claim requires approved generated content');
      if (schedule.mediaAsset?.status !== 'READY')
        throw new Error('Prepared media asset is missing or not ready');
      if (existing) {
        const leaseToken = randomUUID();
        const attempt = await tx.publishAttempt.update({
          where: { id: existing.id },
          data: { leaseToken, leaseExpiresAt: new Date(now.getTime() + LEASE_MS) },
        });
        return { kind: 'RESUMED', attempt, leaseToken };
      }
      const leaseToken = randomUUID();
      const attempt = await tx.publishAttempt.create({
        data: {
          videoId: schedule.videoId,
          scheduleId: schedule.id,
          idempotencyKey: `publish:${schedule.id}`,
          leaseToken,
          leaseExpiresAt: new Date(now.getTime() + LEASE_MS),
        },
      });
      await tx.schedule.update({ where: { id: schedule.id }, data: { status: 'PUBLISHING' } });
      await tx.video.update({
        where: { id: schedule.videoId },
        data: { workflowStatus: 'PUBLISHING' },
      });
      await tx.auditLog.create({
        data: {
          actorId: input.actorId,
          action: 'PUBLISH_CLAIMED',
          entity: 'PublishAttempt',
          entityId: attempt.id,
          after: { scheduleId: schedule.id, videoId: schedule.video.videoId },
        },
      });
      return { kind: 'CLAIMED', attempt, leaseToken };
    },
    { maxWait: 10_000, timeout: 15_000 },
  );
}

/** Commit before create-container. A repeated call never authorizes another create. */
export async function markContainerRequested(
  db: PrismaClient,
  input: { attemptId: string; leaseToken: string; actorId: string },
): Promise<{ shouldSend: boolean; attempt: PublishAttempt }> {
  requireActor(input.actorId);
  return db.$transaction(async (tx) => {
    const attempt = await lockAttempt(tx, input.attemptId);
    assertLease(attempt, input.leaseToken);
    if (attempt.status !== 'CLAIMED' || attempt.containerId)
      throw new Error(`Container request cannot start from ${attempt.status}`);
    if (attempt.containerRequestedAt) return { shouldSend: false, attempt };
    const updated = await tx.publishAttempt.update({
      where: { id: attempt.id },
      data: { containerRequestedAt: new Date() },
    });
    await tx.auditLog.create({
      data: {
        actorId: input.actorId,
        action: 'CONTAINER_REQUEST_STARTED',
        entity: 'PublishAttempt',
        entityId: attempt.id,
      },
    });
    return { shouldSend: true, attempt: updated };
  });
}

/** Persist the container before any status polling or publish request. */
export async function recordPublishContainer(
  db: PrismaClient,
  input: { attemptId: string; leaseToken: string; containerId: string; actorId: string },
) {
  requireActor(input.actorId);
  if (!input.containerId.trim()) throw new Error('containerId is required');
  return db.$transaction(async (tx) => {
    const attempt = await lockAttempt(tx, input.attemptId);
    assertLease(attempt, input.leaseToken);
    if (attempt.containerId && attempt.containerId !== input.containerId)
      throw new Error('A different container is already persisted for this attempt');
    if (!['CLAIMED', 'CONTAINER_CREATED'].includes(attempt.status))
      throw new Error(`Container cannot be recorded from ${attempt.status}`);
    if (!attempt.containerRequestedAt) throw new Error('Container request marker is required');
    if (attempt.containerId) return attempt;
    const updated = await tx.publishAttempt.update({
      where: { id: attempt.id },
      data: { containerId: input.containerId, status: 'CONTAINER_CREATED' },
    });
    await tx.auditLog.create({
      data: {
        actorId: input.actorId,
        action: 'PUBLISH_CONTAINER_RECORDED',
        entity: 'PublishAttempt',
        entityId: attempt.id,
        after: { containerId: input.containerId },
      },
    });
    return updated;
  });
}

export async function markPublishContainerProcessing(
  db: PrismaClient,
  input: { attemptId: string; leaseToken: string },
) {
  return db.$transaction(async (tx) => {
    const attempt = await lockAttempt(tx, input.attemptId);
    assertLease(attempt, input.leaseToken);
    if (!attempt.containerId || !['CONTAINER_CREATED', 'PROCESSING'].includes(attempt.status))
      throw new Error(`Container processing cannot start from ${attempt.status}`);
    return tx.publishAttempt.update({ where: { id: attempt.id }, data: { status: 'PROCESSING' } });
  });
}

/** The commit precedes the external publish call. Re-entry never authorizes a second call. */
export async function markPublishRequested(
  db: PrismaClient,
  input: { attemptId: string; leaseToken: string; actorId: string },
): Promise<{ shouldSend: boolean; attempt: PublishAttempt }> {
  requireActor(input.actorId);
  return db.$transaction(async (tx) => {
    const attempt = await lockAttempt(tx, input.attemptId);
    assertLease(attempt, input.leaseToken);
    if (attempt.status === 'PUBLISH_REQUESTED') return { shouldSend: false, attempt };
    if (!attempt.containerId || !['CONTAINER_CREATED', 'PROCESSING'].includes(attempt.status))
      throw new Error(`Publish request cannot start from ${attempt.status}`);
    const updated = await tx.publishAttempt.update({
      where: { id: attempt.id },
      data: { status: 'PUBLISH_REQUESTED', publishRequestedAt: new Date() },
    });
    await tx.auditLog.create({
      data: {
        actorId: input.actorId,
        action: 'PUBLISH_REQUEST_STARTED',
        entity: 'PublishAttempt',
        entityId: attempt.id,
        after: { containerId: attempt.containerId },
      },
    });
    return { shouldSend: true, attempt: updated };
  });
}

/** Save the returned media ID immediately, before permalink lookup and finalization. */
export async function persistPublishMediaId(
  db: PrismaClient,
  input: { attemptId: string; leaseToken: string; mediaId: string; actorId: string },
) {
  requireActor(input.actorId);
  if (!input.mediaId.trim()) throw new Error('mediaId is required');
  return db.$transaction(async (tx) => {
    const attempt = await lockAttempt(tx, input.attemptId);
    assertLease(attempt, input.leaseToken);
    if (attempt.status !== 'PUBLISH_REQUESTED' && attempt.status !== 'RECONCILE_REQUIRED')
      throw new Error(`Media ID cannot be recorded from ${attempt.status}`);
    if (attempt.mediaId && attempt.mediaId !== input.mediaId)
      throw new Error('A different media ID is already persisted for this attempt');
    if (attempt.mediaId) return attempt;
    const updated = await tx.publishAttempt.update({
      where: { id: attempt.id },
      data: { mediaId: input.mediaId },
    });
    await tx.auditLog.create({
      data: {
        actorId: input.actorId,
        action: 'PUBLISH_MEDIA_ID_RECORDED',
        entity: 'PublishAttempt',
        entityId: attempt.id,
        after: { mediaId: input.mediaId },
      },
    });
    return updated;
  });
}

/** Unknown outcome is a durable state and a reconciliation job, never an automatic republish. */
export async function requirePublishReconciliation(
  db: PrismaClient,
  input: { attemptId: string; actorId: string; reason: string; leaseToken?: string },
) {
  requireActor(input.actorId);
  requireEvidenceCode(input.reason);
  return db.$transaction(async (tx) => {
    const attempt = await lockAttempt(tx, input.attemptId);
    if (input.leaseToken) assertLease(attempt, input.leaseToken);
    if (
      !['PUBLISH_REQUESTED', 'RECONCILE_REQUIRED'].includes(attempt.status) &&
      !(attempt.status === 'CLAIMED' && attempt.containerRequestedAt)
    )
      throw new Error(`Reconciliation cannot be required from ${attempt.status}`);
    return flagForReconciliation(tx, attempt, input.actorId, input.reason);
  });
}

export async function notePublishReconciliationCheck(
  db: PrismaClient,
  input: { attemptId: string; actorId: string; outcome: string },
) {
  requireActor(input.actorId);
  requireEvidenceCode(input.outcome);
  return db.$transaction(async (tx) => {
    const attempt = await lockAttempt(tx, input.attemptId);
    if (attempt.status !== 'RECONCILE_REQUIRED')
      throw new Error('Only uncertain attempts can record reconciliation checks');
    const updated = await tx.publishAttempt.update({
      where: { id: attempt.id },
      data: { lastReconciledAt: new Date() },
    });
    await tx.auditLog.create({
      data: {
        actorId: input.actorId,
        action: 'PUBLISH_RECONCILIATION_CHECKED',
        entity: 'PublishAttempt',
        entityId: attempt.id,
        after: { outcome: input.outcome.slice(0, 120) },
      },
    });
    return updated;
  });
}

/** Restart recovery: expired pre-request leases resume; sent requests reconcile. */
export async function recoverStalePublishAttempts(
  db: PrismaClient,
  input: { actorId: string; now?: Date; limit?: number },
): Promise<{ resume: string[]; reconcile: string[] }> {
  requireActor(input.actorId);
  const now = input.now ?? new Date();
  const limit = input.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 500)
    throw new Error('limit must be an integer from 1 to 500');
  return db.$transaction(async (tx) => {
    const stale = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "PublishAttempt"
      WHERE "leaseExpiresAt" <= ${now}
        AND "status" IN ('CLAIMED'::"PublishAttemptStatus", 'CONTAINER_CREATED'::"PublishAttemptStatus", 'PROCESSING'::"PublishAttemptStatus", 'PUBLISH_REQUESTED'::"PublishAttemptStatus")
      ORDER BY "leaseExpiresAt" ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    `;
    const result = { resume: [] as string[], reconcile: [] as string[] };
    for (const row of stale) {
      const attempt = await tx.publishAttempt.findUniqueOrThrow({ where: { id: row.id } });
      if (
        attempt.status === 'PUBLISH_REQUESTED' ||
        (attempt.status === 'CLAIMED' && attempt.containerRequestedAt)
      ) {
        await flagForReconciliation(
          tx,
          attempt,
          input.actorId,
          attempt.status === 'CLAIMED'
            ? 'CONTAINER_CREATE_OUTCOME_UNCERTAIN'
            : 'PUBLISH_LEASE_EXPIRED_AFTER_REQUEST',
        );
        result.reconcile.push(attempt.id);
        continue;
      }
      await tx.outboxEvent.upsert({
        where: { eventKey: `resume:${attempt.id}:${attempt.updatedAt.toISOString()}` },
        create: {
          eventKey: `resume:${attempt.id}:${attempt.updatedAt.toISOString()}`,
          eventType: 'publish.resume',
          payload: { attemptId: attempt.id, scheduleId: attempt.scheduleId },
        },
        update: {},
      });
      result.resume.push(attempt.id);
    }
    return result;
  });
}
