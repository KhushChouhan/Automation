import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type { discoverVideo as discoverVideoFunction } from '../src/videos.js';
import type { selectDailyReels as selectDailyReelsFunction } from '../src/selection.js';

const testDatabaseUrl = process.env['TEST_DATABASE_URL'];
const runWithDatabase = Boolean(testDatabaseUrl);

describe('PostgreSQL persistence invariants', () => {
  let db: PrismaClient | undefined;
  let discoverVideo: typeof discoverVideoFunction | undefined;
  let selectDailyReels: typeof selectDailyReelsFunction | undefined;
  const createdDriveIds: string[] = [];
  const createdVideoIds: string[] = [];
  const createdFaceIds: string[] = [];
  const createdBusinessDate = '2099-01-15';

  beforeAll(async () => {
    if (!testDatabaseUrl) return;
    const [{ PrismaClient }, videos, selection] = await Promise.all([
      import('@prisma/client'),
      import('../src/videos.js'),
      import('../src/selection.js'),
    ]);
    db = new PrismaClient({ datasources: { db: { url: testDatabaseUrl } } });
    discoverVideo = videos.discoverVideo;
    selectDailyReels = selection.selectDailyReels;
  });

  afterAll(async () => {
    if (!db) return;
    await db.$transaction(async (tx) => {
      const videos = await tx.video.findMany({
        where: { driveFileId: { in: createdDriveIds } },
        select: { id: true },
      });
      const ids = [...createdVideoIds, ...videos.map((video) => video.id)];
      if (ids.length) {
        const schedules = await tx.schedule.findMany({
          where: { videoId: { in: ids } },
          select: { id: true, jobId: true },
        });
        await tx.outboxEvent.deleteMany({
          where: {
            eventKey: { in: schedules.map((schedule) => schedule.jobId) },
          },
        });
        await tx.schedule.deleteMany({ where: { videoId: { in: ids } } });
        await tx.sheetRowSync.deleteMany({ where: { videoId: { in: ids } } });
        await tx.syncConflict.deleteMany({ where: { videoId: { in: ids } } });
        await tx.thumbnail.deleteMany({ where: { videoId: { in: ids } } });
        await tx.video.deleteMany({ where: { id: { in: ids } } });
      }
      if (createdFaceIds.length)
        await tx.face.deleteMany({ where: { id: { in: createdFaceIds } } });
    });
    await db.$disconnect();
  });

  it.skipIf(!runWithDatabase)(
    'keeps one permanent Video ID when a Drive source is discovered twice',
    async () => {
      const client = db;
      const discover = discoverVideo;
      if (!client || !discover) throw new Error('Test database did not initialize');
      const driveFileId = `qa-source-${crypto.randomUUID()}`;
      createdDriveIds.push(driveFileId);
      const first = await discover(client, { driveFileId });
      const second = await discover(client, { driveFileId });
      expect(second.id).toBe(first.id);
      expect(second.videoId).toBe(first.videoId);
      await expect(
        client.video.update({
          where: { id: first.id },
          data: { driveFileId: `${driveFileId}-replacement` },
        }),
      ).rejects.toThrow(/immutable/);
      await expect(
        client.video.update({ where: { id: first.id }, data: { videoId: `${first.videoId}0` } }),
      ).rejects.toThrow(/immutable/);
      expect(await client.video.count({ where: { driveFileId } })).toBe(1);
    },
  );

  it.skipIf(!runWithDatabase)(
    'allocates one permanent Video ID when the same Drive source is discovered concurrently',
    async () => {
      const client = db;
      const discover = discoverVideo;
      if (!client || !discover) throw new Error('Test database did not initialize');
      const driveFileId = `qa-concurrent-source-${crypto.randomUUID()}`;
      createdDriveIds.push(driveFileId);
      const discoveries = await Promise.all(
        Array.from({ length: 8 }, () => discover(client, { driveFileId })),
      );
      expect(new Set(discoveries.map((video) => video.id)).size).toBe(1);
      expect(new Set(discoveries.map((video) => video.videoId)).size).toBe(1);
      expect(await client.video.count({ where: { driveFileId } })).toBe(1);
    },
  );

  it.skipIf(!runWithDatabase)(
    'serializes concurrent selectors without duplicate or excess schedules',
    async () => {
      const client = db;
      const select = selectDailyReels;
      if (!client || !select) throw new Error('Test database did not initialize');
      const token = crypto.randomUUID();
      const numericToken = `${Date.now()}${Math.floor(Math.random() * 1_000_000)}`;
      const faces = await Promise.all(
        ['a', 'b', 'c'].map((suffix) =>
          client.face.create({ data: { name: `qa-${token}-${suffix}` } }),
        ),
      );
      createdFaceIds.push(...faces.map((face) => face.id));
      const videos = await Promise.all(
        faces.map((face, index) => {
          const driveFileId = `qa-selector-${token}-${index}`;
          createdDriveIds.push(driveFileId);
          return client.video.create({
            data: {
              videoId: `GCS-${numericToken}${index}`,
              driveFileId,
              title: 'Approved title',
              thumbnail: { create: { driveFileId: `cover-${driveFileId}` } },
              faceId: face.id,
              workflowStatus: 'READY',
              approvalStatus: 'APPROVED',
              readyAt: new Date(Date.UTC(2026, 0, index + 1)),
            },
          });
        }),
      );
      createdVideoIds.push(...videos.map((video) => video.id));

      const [first, second] = await Promise.all([
        select(client, { businessDate: createdBusinessDate, actorId: 'qa-test' }),
        select(client, { businessDate: createdBusinessDate, actorId: 'qa-test' }),
      ]);
      const schedules = await client.schedule.findMany({
        where: { businessDate: createdBusinessDate },
      });
      expect(schedules).toHaveLength(2);
      expect(new Set(schedules.map((schedule) => schedule.videoId)).size).toBe(2);
      expect(new Set(schedules.map((schedule) => schedule.faceId)).size).toBe(2);
      expect(new Set(schedules.map((schedule) => schedule.slotHour)).size).toBe(2);
      expect(first.length).toBeLessThanOrEqual(2);
      expect(second.length).toBeLessThanOrEqual(2);
    },
  );
});
