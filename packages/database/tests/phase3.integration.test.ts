import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient as PrismaClientType } from '@prisma/client';

const testDatabaseUrl = process.env['TEST_DATABASE_URL'];
let db: PrismaClientType | undefined;
let videoId = '';
let scheduleId = '';
const suffix = randomUUID().replaceAll('-', '').slice(0, 10);

beforeAll(async () => {
  if (!testDatabaseUrl) return;
  process.env['DATABASE_URL'] = testDatabaseUrl;
  const { PrismaClient } = await import('@prisma/client');
  db = new PrismaClient();
  const face = await db.face.create({ data: { name: `phase3-face-${suffix}` } });
  videoId = `GCS-${Date.now().toString().slice(-8)}`;
  const video = await db.video.create({
    data: {
      videoId,
      driveFileId: `phase3-drive-${suffix}`,
      sourceMimeType: 'video/mp4',
      sourceSizeBytes: 1234,
      faceId: face.id,
      title: 'Human-owned title',
      approvalStatus: 'APPROVED',
      workflowStatus: 'SELECTED',
      readyAt: new Date(),
      thumbnail: { create: { driveFileId: `phase3-thumb-${suffix}`, mimeType: 'image/jpeg' } },
    },
  });
  const schedule = await db.schedule.create({
    data: {
      videoId: video.id,
      faceId: face.id,
      businessDate: '2026-11-15',
      slotHour: 19,
      scheduledAt: new Date('2026-11-15T13:30:00.000Z'),
      jobId: `publish:${videoId}:2026-11-15T13:30:00.000Z`,
    },
  });
  scheduleId = schedule.id;
});

afterAll(async () => {
  if (!db) return;
  await db.mediaAsset.deleteMany({ where: { scheduleId } });
  await db.outboxEvent.deleteMany({ where: { eventKey: { contains: scheduleId } } });
  await db.content.deleteMany({ where: { video: { videoId } } });
  await db.schedule.deleteMany({ where: { id: scheduleId } });
  const video = await db.video.findUnique({
    where: { videoId },
    select: { id: true, faceId: true },
  });
  if (video) {
    await db.thumbnail.deleteMany({ where: { videoId: video.id } });
    // AuditLog is intentionally append-only in every environment, including local acceptance.
    // Keep the evidence row while removing the disposable domain fixture.
    await db.video.delete({ where: { id: video.id } });
    if (video.faceId) await db.face.delete({ where: { id: video.faceId } });
  }
  await db.$disconnect();
});

describe.skipIf(!testDatabaseUrl)('Phase 3 content and media persistence', () => {
  it('keeps the manual title, reuses normal generation and versions explicit regeneration', async () => {
    const { beginContentGeneration, completeContentGeneration } = await import('../src/content.js');
    const client = db!;
    const first = await beginContentGeneration(client, {
      videoId,
      promptVersion: 'v1',
      modelName: 'fake-model',
      actorId: 'test',
    });
    expect(first.reused).toBe(false);
    await completeContentGeneration(client, {
      videoId,
      generationKey: first.generationKey,
      promptVersion: 'v1',
      provider: 'fake',
      modelName: 'fake-model',
      result: {
        caption: 'Caption',
        hashtags: ['Jaipur', '#Jaipur'],
        cta: 'Learn more',
        model: 'fake-model',
      },
      actorId: 'test',
    });
    const repeated = await beginContentGeneration(client, {
      videoId,
      promptVersion: 'v1',
      modelName: 'fake-model',
      actorId: 'test',
    });
    expect(repeated.reused).toBe(true);
    const regeneration = await beginContentGeneration(client, {
      videoId,
      promptVersion: 'v1',
      modelName: 'fake-model',
      actorId: 'test',
      regenerate: true,
      regenerationRequestId: 'request-0001',
    });
    await completeContentGeneration(client, {
      videoId,
      generationKey: regeneration.generationKey,
      promptVersion: 'v1',
      provider: 'fake',
      modelName: 'fake-model',
      result: {
        caption: 'Caption two',
        hashtags: ['#Property'],
        cta: 'Contact us',
        model: 'fake-model',
      },
      actorId: 'test',
      regenerated: true,
    });
    const video = await client.video.findUniqueOrThrow({
      where: { videoId },
      include: { content: true },
    });
    expect(video.title).toBe('Human-owned title');
    expect(video.workflowStatus).toBe('CONTENT_READY');
    expect(video.content).toHaveLength(2);
    expect(video.content[1]?.regenerated).toBe(true);
  });

  it('persists deterministic prepared media and idempotent cleanup', async () => {
    const { beginMediaPreparation, completeMediaPreparation, markMediaCleaned } =
      await import('../src/media.js');
    const client = db!;
    const claim = await beginMediaPreparation(client, {
      videoId,
      provider: 'local',
      bucket: 'test',
      actorId: 'test',
    });
    expect(claim.keys.video).toContain(`reels/${videoId}/`);
    await completeMediaPreparation(client, {
      scheduleId,
      sizeBytes: 1234n,
      checksum: 'abc',
      expiresAt: new Date(Date.now() + 600_000),
      actorId: 'test',
    });
    const repeated = await beginMediaPreparation(client, {
      videoId,
      provider: 'local',
      bucket: 'test',
      actorId: 'test',
    });
    expect(repeated.reused).toBe(true);
    await markMediaCleaned(client, scheduleId, 'test');
    expect((await client.mediaAsset.findUniqueOrThrow({ where: { scheduleId } })).status).toBe(
      'CLEANED',
    );
    const providerSwitch = await beginMediaPreparation(client, {
      videoId,
      provider: 'cloudinary',
      bucket: 'test-cloud',
      actorId: 'test',
    });
    expect(providerSwitch.asset).toMatchObject({
      provider: 'cloudinary',
      bucket: 'test-cloud',
      status: 'PREPARING',
    });
  });

  it('restores usable content state after a bounded regeneration failure', async () => {
    const { beginContentGeneration, recordContentGenerationFailure } =
      await import('../src/content.js');
    const client = db!;
    await beginContentGeneration(client, {
      videoId,
      promptVersion: 'v1',
      modelName: 'fake-model',
      actorId: 'test',
      regenerate: true,
      regenerationRequestId: 'failed-request-0001',
    });
    await recordContentGenerationFailure(client, {
      videoId,
      actorId: 'test',
      errorCode: 'RATE_LIMIT',
      retryable: true,
      classification: 'RATE_LIMIT',
    });

    expect((await client.video.findUniqueOrThrow({ where: { videoId } })).workflowStatus).toBe(
      'SCHEDULED',
    );
  });
});
