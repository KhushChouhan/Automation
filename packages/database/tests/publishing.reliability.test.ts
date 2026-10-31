import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type { recordSuccessfulPost as RecordSuccessfulPost } from '../src/posting.js';

const testDatabaseUrl = process.env['TEST_DATABASE_URL'];

interface AcceptedMetaPost {
  mediaId: string;
  permalink: string;
}

/** Local-only fake models Meta accepting a request before the response times out. */
class FakeMeta {
  readonly accepted = new Map<string, AcceptedMetaPost>();
  publishCalls = 0;
  private timeoutAfterFirstAcceptance = true;

  publish(idempotencyKey: string): Promise<AcceptedMetaPost> {
    this.publishCalls += 1;
    const existing = this.accepted.get(idempotencyKey);
    if (existing) return Promise.resolve(existing);

    const accepted = {
      // A fresh test database can retain append-only evidence from an
      // interrupted run, so provider IDs must be unique per logical attempt.
      mediaId: `fake-meta-${idempotencyKey}`,
      permalink: `https://fake.invalid/reels/${idempotencyKey}`,
    };
    this.accepted.set(idempotencyKey, accepted);
    if (this.timeoutAfterFirstAcceptance) {
      this.timeoutAfterFirstAcceptance = false;
      return Promise.reject(new Error('simulated timeout after Meta accepted the Reel'));
    }
    return Promise.resolve(accepted);
  }

  lookup(idempotencyKey: string): Promise<AcceptedMetaPost | null> {
    return Promise.resolve(this.accepted.get(idempotencyKey) ?? null);
  }
}

describe('publish persistence and fake Meta recovery contract', () => {
  let db: PrismaClient | undefined;
  let recordSuccessfulPost: typeof RecordSuccessfulPost | undefined;
  const ownedVideoIds: string[] = [];
  const ownedFaceIds: string[] = [];

  beforeAll(async () => {
    if (!testDatabaseUrl) return;
    const [{ PrismaClient }, posting] = await Promise.all([
      import('@prisma/client'),
      import('../src/posting.js'),
    ]);
    db = new PrismaClient({ datasources: { db: { url: testDatabaseUrl } } });
    recordSuccessfulPost = posting.recordSuccessfulPost;
  });

  afterAll(async () => {
    if (!db) return;
    await db.$transaction(async (tx) => {
      if (ownedVideoIds.length) {
        // PostingHistory is intentionally append-only. Tests that prove a
        // successful publication retain that isolated evidence rather than
        // bypassing the database guard to delete it.
        const postedVideoIds = (
          await tx.postingHistory.findMany({
            where: { videoId: { in: ownedVideoIds } },
            select: { videoId: true },
          })
        ).map((row) => row.videoId);
        const removableVideoIds = ownedVideoIds.filter((id) => !postedVideoIds.includes(id));
        if (!removableVideoIds.length) return;
        await tx.publishAttempt.deleteMany({ where: { videoId: { in: removableVideoIds } } });
        await tx.auditLog.deleteMany({ where: { entityId: { in: removableVideoIds } } });
        await tx.mediaAsset.deleteMany({ where: { videoId: { in: removableVideoIds } } });
        await tx.schedule.deleteMany({ where: { videoId: { in: removableVideoIds } } });
        await tx.video.deleteMany({ where: { id: { in: removableVideoIds } } });
      }
      if (ownedFaceIds.length) {
        const unusedFaces = await tx.face.findMany({
          where: { id: { in: ownedFaceIds }, videos: { none: {} } },
          select: { id: true },
        });
        await tx.face.deleteMany({ where: { id: { in: unusedFaces.map((face) => face.id) } } });
      }
    });
    await db.$disconnect();
  });

  async function setupPublishAttempt() {
    const client = db;
    if (!client) throw new Error('Test database did not initialize');
    const unique = crypto.randomUUID().replaceAll('-', '');
    const sequence = `${Date.now()}${Math.floor(Math.random() * 1_000_000)}`;
    const face = await client.face.create({ data: { name: `qa-meta-${unique}` } });
    ownedFaceIds.push(face.id);
    const video = await client.video.create({
      data: {
        videoId: `GCS-${sequence}`,
        driveFileId: `qa-meta-video-${unique}`,
        faceId: face.id,
        workflowStatus: 'PUBLISHING',
        approvalStatus: 'APPROVED',
      },
    });
    ownedVideoIds.push(video.id);
    const dateSeed = Number.parseInt(unique.slice(0, 8), 16);
    const year = 9000 + (dateSeed % 1000);
    const dayOfYear = ((dateSeed >>> 10) % 365) + 1;
    const scheduledAt = new Date(Date.UTC(year, 0, dayOfYear, 13, 30));
    const businessDate = scheduledAt.toISOString().slice(0, 10);
    const jobId = `publish:${video.videoId}:${scheduledAt.toISOString()}`;
    const schedule = await client.schedule.create({
      data: {
        videoId: video.id,
        faceId: face.id,
        businessDate,
        slotHour: 19,
        scheduledAt,
        jobId,
        status: 'PUBLISHING',
      },
    });
    const mediaAsset = await client.mediaAsset.create({
      data: {
        videoId: video.id,
        scheduleId: schedule.id,
        provider: 'fake',
        videoObjectKey: `qa-meta-object-${unique}`,
        contentType: 'video/mp4',
        sizeBytes: 100n,
        status: 'READY',
      },
    });
    const attempt = await client.publishAttempt.create({
      data: {
        videoId: video.id,
        scheduleId: schedule.id,
        idempotencyKey: jobId,
        status: 'PUBLISH_REQUESTED',
        containerId: `qa-container-${unique}`,
        containerRequestedAt: scheduledAt,
        publishRequestedAt: scheduledAt,
      },
    });
    return { client, video, schedule, attempt, mediaAsset, businessDate };
  }

  it.skipIf(!testDatabaseUrl)(
    'reconciles an accepted-but-timed-out fake Meta publish after a simulated worker crash',
    async () => {
      const persist = recordSuccessfulPost;
      if (!persist) throw new Error('Posting persistence did not initialize');
      const { client, video, schedule, attempt, mediaAsset } = await setupPublishAttempt();
      const meta = new FakeMeta();

      await expect(meta.publish(attempt.idempotencyKey)).rejects.toThrow(/simulated timeout/);
      // The worker crashes before writing PostingHistory. Recovery queries Meta before retrying.
      expect(await client.postingHistory.count({ where: { videoId: video.id } })).toBe(0);
      const accepted = await meta.lookup(attempt.idempotencyKey);
      expect(accepted).not.toBeNull();
      expect(meta.publishCalls).toBe(1);

      const postedAt = new Date(schedule.scheduledAt.getTime() + 5 * 60_000);
      const firstDelivery = await persist(client, {
        videoId: video.videoId,
        publishAttemptId: attempt.id,
        instagramMediaId: accepted!.mediaId,
        permalink: accepted!.permalink,
        postedAt,
      });
      // At-least-once queue delivery repeats the same completion after recovery.
      const duplicateDelivery = await persist(client, {
        videoId: video.videoId,
        publishAttemptId: attempt.id,
        instagramMediaId: accepted!.mediaId,
        permalink: accepted!.permalink,
        postedAt,
      });

      expect(duplicateDelivery.id).toBe(firstDelivery.id);
      expect(await client.postingHistory.count({ where: { videoId: video.id } })).toBe(1);
      expect(
        await client.auditLog.count({ where: { entityId: video.id, action: 'VIDEO_POSTED' } }),
      ).toBe(1);
      expect(
        await client.publishAttempt.findUniqueOrThrow({ where: { id: attempt.id } }),
      ).toMatchObject({
        status: 'SUCCEEDED',
        mediaId: accepted!.mediaId,
      });
      expect(await client.schedule.findUniqueOrThrow({ where: { id: schedule.id } })).toMatchObject(
        { status: 'POSTED' },
      );
      expect(await client.video.findUniqueOrThrow({ where: { id: video.id } })).toMatchObject({
        workflowStatus: 'POSTED',
      });
      const mirrorEvent = await client.outboxEvent.findUniqueOrThrow({
        where: { eventKey: `sheet-mirror:${video.videoId}` },
      });
      expect(mirrorEvent).toMatchObject({
        eventType: 'sheet.mirror',
        payload: { videoId: video.videoId, scheduleId: schedule.id },
      });
      const cleanupEvent = await client.outboxEvent.findUniqueOrThrow({
        where: { eventKey: `cleanup:${mediaAsset.id}` },
      });
      expect(cleanupEvent).toMatchObject({
        eventType: 'media.cleanup',
        payload: { assetId: mediaAsset.id, videoId: video.videoId, scheduleId: schedule.id },
      });
      expect(cleanupEvent.availableAt.getTime()).toBeGreaterThanOrEqual(
        postedAt.getTime() + 24 * 60 * 60_000,
      );
      expect(
        await client.outboxEvent.count({
          where: { eventKey: { in: [mirrorEvent.eventKey, cleanupEvent.eventKey] } },
        }),
      ).toBe(2);
    },
  );

  it.skipIf(!testDatabaseUrl)(
    'treats the same Instagram media ID as idempotent and rejects a different ID',
    async () => {
      const persist = recordSuccessfulPost;
      if (!persist) throw new Error('Posting persistence did not initialize');
      const { client, video, schedule, attempt } = await setupPublishAttempt();
      const input = {
        videoId: video.videoId,
        publishAttemptId: attempt.id,
        instagramMediaId: `fake-meta-media-${video.videoId}`,
        postedAt: new Date(schedule.scheduledAt.getTime() + 5 * 60_000),
      };
      const original = await persist(client, input);
      const retry = await persist(client, input);
      expect(retry.id).toBe(original.id);
      await expect(
        persist(client, { ...input, instagramMediaId: `fake-meta-duplicate-${video.videoId}` }),
      ).rejects.toThrow(/already posted as another Instagram media ID/);
      expect(await client.postingHistory.count({ where: { videoId: video.id } })).toBe(1);
    },
  );

  it.skipIf(!testDatabaseUrl)(
    'rolls back finalization and outbox dispatch for a mismatched attempt',
    async () => {
      const persist = recordSuccessfulPost;
      if (!persist) throw new Error('Posting persistence did not initialize');
      const { client, video, schedule, mediaAsset } = await setupPublishAttempt();
      await expect(
        persist(client, {
          videoId: video.videoId,
          publishAttemptId: crypto.randomUUID(),
          instagramMediaId: `fake-invalid-${video.videoId}`,
          postedAt: schedule.scheduledAt,
        }),
      ).rejects.toThrow();
      expect(await client.postingHistory.count({ where: { videoId: video.id } })).toBe(0);
      expect(
        await client.outboxEvent.count({ where: { eventKey: `sheet-mirror:${video.videoId}` } }),
      ).toBe(0);
      expect(
        await client.outboxEvent.count({ where: { eventKey: `cleanup:${mediaAsset.id}` } }),
      ).toBe(0);
      expect(
        (await client.publishAttempt.findFirstOrThrow({ where: { videoId: video.id } })).status,
      ).toBe('PUBLISH_REQUESTED');
    },
  );
});
