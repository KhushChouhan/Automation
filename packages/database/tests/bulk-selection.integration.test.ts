import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type { selectReadyBacklog as selectReadyBacklogFunction } from '../src/selection.js';

const testDatabaseUrl = process.env['TEST_DATABASE_URL'];

describe('bulk backlog selection persistence', () => {
  let db: PrismaClient | undefined;
  let selectReadyBacklog: typeof selectReadyBacklogFunction | undefined;
  const createdVideoIds: string[] = [];
  const createdFaceIds: string[] = [];

  beforeAll(async () => {
    if (!testDatabaseUrl) return;
    const [{ PrismaClient }, selection] = await Promise.all([
      import('@prisma/client'),
      import('../src/selection.js'),
    ]);
    db = new PrismaClient({ datasources: { db: { url: testDatabaseUrl } } });
    selectReadyBacklog = selection.selectReadyBacklog;
  });

  afterAll(async () => {
    if (!db) return;
    await db.$transaction(async (tx) => {
      if (createdVideoIds.length) {
        const schedules = await tx.schedule.findMany({
          where: { videoId: { in: createdVideoIds } },
          select: { id: true, jobId: true },
        });
        await tx.outboxEvent.deleteMany({
          where: { eventKey: { in: schedules.map((schedule) => schedule.jobId) } },
        });
        await tx.schedule.deleteMany({ where: { videoId: { in: createdVideoIds } } });
        await tx.video.deleteMany({ where: { id: { in: createdVideoIds } } });
      }
      if (createdFaceIds.length)
        await tx.face.deleteMany({ where: { id: { in: createdFaceIds } } });
    });
    await db.$disconnect();
  });

  it.skipIf(!testDatabaseUrl)(
    'plans a 50-video backlog once across concurrent calls and preserves it after reconnect',
    async () => {
      const initialClient = db;
      const planner = selectReadyBacklog;
      if (!initialClient || !planner) throw new Error('Test database did not initialize');

      const token = crypto.randomUUID();
      const numericToken = `${Date.now()}${Math.floor(Math.random() * 1_000_000)}`;
      const dayOffset = Math.floor(Math.random() * 36_500);
      const start = new Date(Date.UTC(2090, 0, 1 + dayOffset));
      const startBusinessDate = start.toISOString().slice(0, 10);
      const now = new Date(`${startBusinessDate}T00:00:00.000Z`);
      const faces = await Promise.all(
        Array.from({ length: 10 }, (_, index) =>
          initialClient.face.create({ data: { name: `qa-bulk-${token}-${index}` } }),
        ),
      );
      createdFaceIds.push(...faces.map((face) => face.id));

      const videos = await Promise.all(
        Array.from({ length: 50 }, (_, index) =>
          initialClient.video.create({
            data: {
              videoId: `GCS-${numericToken}${String(index).padStart(2, '0')}`,
              faceId: faces[index % faces.length]!.id,
              workflowStatus: 'READY',
              approvalStatus: 'APPROVED',
              readyAt: new Date(Date.UTC(2025, 0, 1, 0, 0, index)),
            },
          }),
        ),
      );
      createdVideoIds.push(...videos.map((video) => video.id));

      const options = {
        actorId: 'qa-bulk-selection',
        gapDays: 2,
        horizonDays: 30,
        now,
        startBusinessDate,
      };
      const [first, concurrent] = await Promise.all([
        planner(initialClient, options),
        planner(initialClient, options),
      ]);
      expect(first.length + concurrent.length).toBe(50);

      const persisted = await initialClient.schedule.findMany({
        where: { videoId: { in: createdVideoIds } },
        orderBy: [{ businessDate: 'asc' }, { slotHour: 'asc' }],
        select: { videoId: true, faceId: true, businessDate: true, slotHour: true, jobId: true },
      });
      expect(persisted).toHaveLength(50);
      expect(persisted.slice(0, 2).map((schedule) => schedule.videoId)).toEqual(
        videos.slice(0, 2).map((video) => video.id),
      );
      expect(persisted[0]?.slotHour).toBe(19);
      expect(persisted[1]?.slotHour).toBe(20);

      const perDay = new Map<string, typeof persisted>();
      for (const schedule of persisted) {
        const day = perDay.get(schedule.businessDate) ?? [];
        day.push(schedule);
        perDay.set(schedule.businessDate, day);
      }
      for (const day of perDay.values()) {
        expect(day.length).toBeLessThanOrEqual(2);
        expect(new Set(day.map((schedule) => schedule.faceId)).size).toBe(day.length);
      }
      const datesByFace = new Map<string, string[]>();
      for (const schedule of persisted) {
        const dates = datesByFace.get(schedule.faceId) ?? [];
        dates.push(schedule.businessDate);
        datesByFace.set(schedule.faceId, dates);
      }
      for (const dates of datesByFace.values()) {
        for (let index = 1; index < dates.length; index += 1) {
          const distance =
            (Date.parse(`${dates[index]}T00:00:00Z`) -
              Date.parse(`${dates[index - 1]}T00:00:00Z`)) /
            86_400_000;
          expect(distance).toBeGreaterThanOrEqual(2);
        }
      }
      expect(
        await initialClient.outboxEvent.count({
          where: { eventKey: { in: persisted.map((schedule) => schedule.jobId) } },
        }),
      ).toBe(50);

      await initialClient.$disconnect();
      const { PrismaClient } = await import('@prisma/client');
      db = new PrismaClient({ datasources: { db: { url: testDatabaseUrl! } } });
      const afterReconnect = await planner(db, options);
      expect(afterReconnect).toHaveLength(0);
      expect(await db.schedule.count({ where: { videoId: { in: createdVideoIds } } })).toBe(50);
    },
  );
});
