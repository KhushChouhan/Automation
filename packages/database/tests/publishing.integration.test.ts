import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type {
  claimScheduledPublish as Claim,
  markPublishRequested as MarkRequested,
  markContainerRequested as MarkContainerRequested,
  recordPublishContainer as RecordContainer,
  recoverStalePublishAttempts as RecoverStale,
  requirePublishReconciliation as RequireReconciliation,
} from '../src/publishing.js';

const testDatabaseUrl = process.env['TEST_DATABASE_URL'];

describe('publish claim and reconciliation persistence', () => {
  let db: PrismaClient | undefined;
  let claim: typeof Claim;
  let markRequested: typeof MarkRequested;
  let markContainerRequested: typeof MarkContainerRequested;
  let recordContainer: typeof RecordContainer;
  let recoverStale: typeof RecoverStale;
  let requireReconciliation: typeof RequireReconciliation;
  let scheduleId: string;
  let videoRowId: string;
  let faceId: string;
  let attemptId: string | undefined;
  let resumeScheduleId: string | undefined;
  let resumeVideoRowId: string | undefined;
  let resumeAttemptId: string | undefined;
  let uncertainScheduleId: string | undefined;
  let uncertainVideoRowId: string | undefined;
  let uncertainAttemptId: string | undefined;
  const tag = crypto.randomUUID();

  beforeAll(async () => {
    if (!testDatabaseUrl) return;
    const [{ PrismaClient }, publishing] = await Promise.all([
      import('@prisma/client'),
      import('../src/publishing.js'),
    ]);
    db = new PrismaClient({ datasources: { db: { url: testDatabaseUrl } } });
    claim = publishing.claimScheduledPublish;
    markRequested = publishing.markPublishRequested;
    markContainerRequested = publishing.markContainerRequested;
    recordContainer = publishing.recordPublishContainer;
    recoverStale = publishing.recoverStalePublishAttempts;
    requireReconciliation = publishing.requirePublishReconciliation;
    const face = await db.face.create({ data: { name: `qa-publish-${tag}` } });
    faceId = face.id;
    const video = await db.video.create({
      data: {
        videoId: `GCS-${tag.replaceAll('-', '').slice(0, 12).toUpperCase()}`,
        driveFileId: `qa-publish-drive-${tag}`,
        title: 'Prepared reel',
        faceId,
        workflowStatus: 'SCHEDULED',
        approvalStatus: 'APPROVED',
        readyAt: new Date(),
      },
    });
    videoRowId = video.id;
    await db.content.create({
      data: {
        videoId: video.id,
        version: 1,
        generationKey: `qa-publish-content-${tag}`,
        titleSnapshot: video.title!,
        caption: 'Prepared caption',
        hashtags: ['#Test'],
        cta: 'Read more',
        provider: 'fake',
        modelName: 'fake',
        promptVersion: 'qa',
      },
    });
    const schedule = await db.schedule.create({
      data: {
        videoId: video.id,
        faceId,
        businessDate: '2098-12-31',
        slotHour: 19,
        scheduledAt: new Date('2098-12-31T13:30:00.000Z'),
        jobId: `qa-publish-${tag}`,
        status: 'SCHEDULED',
      },
    });
    scheduleId = schedule.id;
    await db.mediaAsset.create({
      data: {
        videoId: video.id,
        scheduleId,
        provider: 'fake',
        videoObjectKey: `qa-publish-object-${tag}`,
        contentType: 'video/mp4',
        sizeBytes: 100,
        status: 'PREPARING',
        expiresAt: new Date('2026-10-28T00:00:00.000Z'),
      },
    });
  });

  afterAll(async () => {
    if (!db) return;
    if (attemptId)
      await db.outboxEvent.deleteMany({ where: { eventKey: `reconcile:${attemptId}` } });
    if (resumeAttemptId) {
      await db.outboxEvent.deleteMany({
        where: { eventKey: { startsWith: `resume:${resumeAttemptId}:` } },
      });
      await db.publishAttempt.delete({ where: { id: resumeAttemptId } });
    }
    if (uncertainAttemptId) {
      await db.outboxEvent.deleteMany({ where: { eventKey: `reconcile:${uncertainAttemptId}` } });
      await db.publishAttempt.delete({ where: { id: uncertainAttemptId } });
    }
    if (uncertainScheduleId) await db.schedule.delete({ where: { id: uncertainScheduleId } });
    if (uncertainVideoRowId) await db.video.delete({ where: { id: uncertainVideoRowId } });
    if (resumeScheduleId) await db.schedule.delete({ where: { id: resumeScheduleId } });
    if (resumeVideoRowId) await db.video.delete({ where: { id: resumeVideoRowId } });
    if (scheduleId) {
      await db.publishAttempt.deleteMany({ where: { scheduleId } });
      await db.mediaAsset.deleteMany({ where: { scheduleId } });
      await db.schedule.delete({ where: { id: scheduleId } });
    }
    if (videoRowId) {
      await db.content.deleteMany({ where: { videoId: videoRowId } });
      await db.video.delete({ where: { id: videoRowId } });
    }
    if (faceId) await db.face.delete({ where: { id: faceId } });
    await db.$disconnect();
  });

  it.skipIf(!testDatabaseUrl)(
    'requires a ready stored asset, tolerates an expired delivery URL, and grants one claim',
    async () => {
      const client = db!;
      const slotNow = new Date('2098-12-31T13:30:00.000Z');
      await expect(
        claim(client, { scheduleId, actorId: 'qa-worker', now: slotNow }),
      ).rejects.toThrow('Prepared media');
      await client.mediaAsset.update({ where: { scheduleId }, data: { status: 'READY' } });
      expect(
        (await client.mediaAsset.findUniqueOrThrow({ where: { scheduleId } })).expiresAt?.getTime(),
      ).toBeLessThan(slotNow.getTime());
      const results = await Promise.all([
        claim(client, { scheduleId, actorId: 'qa-worker-a', now: slotNow }),
        claim(client, { scheduleId, actorId: 'qa-worker-b', now: slotNow }),
      ]);
      expect(results.map((result) => result.kind).sort()).toEqual(['BUSY', 'CLAIMED']);
      expect(await client.publishAttempt.count({ where: { scheduleId } })).toBe(1);
      const claimed = results.find((result) => result.kind === 'CLAIMED');
      if (!claimed || claimed.kind !== 'CLAIMED') throw new Error('Missing claim');
      attemptId = claimed.attempt.id;
      expect(
        (
          await markContainerRequested(client, {
            attemptId,
            leaseToken: claimed.leaseToken,
            actorId: 'qa-worker',
          })
        ).shouldSend,
      ).toBe(true);
      expect(
        (
          await markContainerRequested(client, {
            attemptId,
            leaseToken: claimed.leaseToken,
            actorId: 'qa-worker',
          })
        ).shouldSend,
      ).toBe(false);
      const persisted = await recordContainer(client, {
        attemptId,
        leaseToken: claimed.leaseToken,
        containerId: `qa-container-${tag}`,
        actorId: 'qa-worker',
      });
      expect(persisted.containerId).toBe(`qa-container-${tag}`);
      await expect(
        recordContainer(client, {
          attemptId,
          leaseToken: claimed.leaseToken,
          containerId: `different-${tag}`,
          actorId: 'qa-worker',
        }),
      ).rejects.toThrow('different container');
      expect(
        (
          await markRequested(client, {
            attemptId,
            leaseToken: claimed.leaseToken,
            actorId: 'qa-worker',
          })
        ).shouldSend,
      ).toBe(true);
      expect(
        (
          await markRequested(client, {
            attemptId,
            leaseToken: claimed.leaseToken,
            actorId: 'qa-worker',
          })
        ).shouldSend,
      ).toBe(false);
    },
  );

  it.skipIf(!testDatabaseUrl)(
    'turns an expired uncertain request into one durable reconciliation job',
    async () => {
      const client = db!;
      await client.publishAttempt.update({
        where: { id: attemptId! },
        data: { leaseExpiresAt: new Date(0) },
      });
      const recoveryNow = new Date('2099-01-01T00:00:00.000Z');
      const first = await claim(client, { scheduleId, actorId: 'qa-recovery', now: recoveryNow });
      const second = await claim(client, { scheduleId, actorId: 'qa-recovery', now: recoveryNow });
      expect(first.kind).toBe('RECONCILE_REQUIRED');
      expect(second.kind).toBe('RECONCILE_REQUIRED');
      expect(await client.publishAttempt.count({ where: { scheduleId } })).toBe(1);
      expect(
        await client.outboxEvent.count({ where: { eventKey: `reconcile:${attemptId}` } }),
      ).toBe(1);
      expect((await client.schedule.findUniqueOrThrow({ where: { id: scheduleId } })).status).toBe(
        'RECONCILE_REQUIRED',
      );
      expect(
        (await client.video.findUniqueOrThrow({ where: { id: videoRowId } })).workflowStatus,
      ).toBe('RECONCILE_REQUIRED');
    },
  );

  it.skipIf(!testDatabaseUrl)(
    'requeues a stale pre-request claim without a new attempt',
    async () => {
      const client = db!;
      const video = await client.video.create({
        data: {
          videoId: `GCS-${tag.replaceAll('-', '').slice(12, 24).toUpperCase()}`,
          driveFileId: `qa-resume-drive-${tag}`,
          faceId,
          workflowStatus: 'PUBLISHING',
          approvalStatus: 'APPROVED',
        },
      });
      resumeVideoRowId = video.id;
      const schedule = await client.schedule.create({
        data: {
          videoId: video.id,
          faceId,
          businessDate: '2098-12-30',
          slotHour: 19,
          scheduledAt: new Date('2098-12-30T13:30:00.000Z'),
          jobId: `qa-resume-${tag}`,
          status: 'PUBLISHING',
        },
      });
      resumeScheduleId = schedule.id;
      const attempt = await client.publishAttempt.create({
        data: {
          videoId: video.id,
          scheduleId: schedule.id,
          idempotencyKey: `qa-resume-attempt-${tag}`,
          status: 'CONTAINER_CREATED',
          containerId: `qa-resume-container-${tag}`,
          leaseToken: `qa-stale-lease-${tag}`,
          leaseExpiresAt: new Date(0),
        },
      });
      resumeAttemptId = attempt.id;
      const recovered = await recoverStale(client, { actorId: 'qa-recovery' });
      expect(recovered.resume).toContain(attempt.id);
      expect(await client.publishAttempt.count({ where: { scheduleId: schedule.id } })).toBe(1);
      const event = await client.outboxEvent.findUniqueOrThrow({
        where: { eventKey: `resume:${attempt.id}:${attempt.updatedAt.toISOString()}` },
      });
      expect(event.eventType).toBe('publish.resume');
      expect(event.status).toBe('PENDING');
    },
  );

  it.skipIf(!testDatabaseUrl)(
    'holds an ambiguous create-container timeout for reconciliation',
    async () => {
      const client = db!;
      const video = await client.video.create({
        data: {
          videoId: `GCS-${tag.replaceAll('-', '').slice(24, 32).toUpperCase()}`,
          driveFileId: `qa-uncertain-drive-${tag}`,
          faceId,
          workflowStatus: 'PUBLISHING',
          approvalStatus: 'APPROVED',
        },
      });
      uncertainVideoRowId = video.id;
      const schedule = await client.schedule.create({
        data: {
          videoId: video.id,
          faceId,
          businessDate: '2098-12-28',
          slotHour: 19,
          scheduledAt: new Date('2098-12-28T13:30:00.000Z'),
          jobId: `qa-uncertain-${tag}`,
          status: 'PUBLISHING',
        },
      });
      uncertainScheduleId = schedule.id;
      const leaseToken = `qa-uncertain-lease-${tag}`;
      const attempt = await client.publishAttempt.create({
        data: {
          videoId: video.id,
          scheduleId: schedule.id,
          idempotencyKey: `qa-uncertain-attempt-${tag}`,
          status: 'CLAIMED',
          leaseToken,
          leaseExpiresAt: new Date('2099-01-01T00:00:00.000Z'),
        },
      });
      uncertainAttemptId = attempt.id;
      expect(
        (
          await markContainerRequested(client, {
            attemptId: attempt.id,
            leaseToken,
            actorId: 'qa-worker',
          })
        ).shouldSend,
      ).toBe(true);
      const held = await requireReconciliation(client, {
        attemptId: attempt.id,
        leaseToken,
        actorId: 'qa-worker',
        reason: 'CONTAINER_CREATE_OUTCOME_UNCERTAIN',
      });
      expect(held.status).toBe('RECONCILE_REQUIRED');
      expect(held.containerId).toBeNull();
      expect((await claim(client, { scheduleId: schedule.id, actorId: 'qa-worker' })).kind).toBe(
        'RECONCILE_REQUIRED',
      );
      expect(await client.publishAttempt.count({ where: { scheduleId: schedule.id } })).toBe(1);
      expect(
        await client.outboxEvent.count({ where: { eventKey: `reconcile:${attempt.id}` } }),
      ).toBe(1);
    },
  );
});
