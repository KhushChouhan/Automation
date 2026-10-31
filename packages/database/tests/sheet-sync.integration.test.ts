import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type {
  prepareSheetMirrorRow as PrepareSheetMirrorRow,
  reconcileSheetRow as ReconcileSheetRow,
  recordSheetMirror as RecordSheetMirror,
} from '../src/sheet-sync.js';

const testDatabaseUrl = process.env['TEST_DATABASE_URL'];
const runWithDatabase = Boolean(testDatabaseUrl);

describe('Google Sheet reconciliation and mirror invariants', () => {
  let db: PrismaClient | undefined;
  let reconcileSheetRow: typeof ReconcileSheetRow | undefined;
  let prepareSheetMirrorRow: typeof PrepareSheetMirrorRow | undefined;
  let recordSheetMirror: typeof RecordSheetMirror | undefined;
  const videoIds: string[] = [];
  const driveIds: string[] = [];
  const faceIds: string[] = [];

  beforeAll(async () => {
    if (!testDatabaseUrl) return;
    const [{ PrismaClient }, sync] = await Promise.all([
      import('@prisma/client'),
      import('../src/sheet-sync.js'),
    ]);
    db = new PrismaClient({ datasources: { db: { url: testDatabaseUrl } } });
    reconcileSheetRow = sync.reconcileSheetRow;
    prepareSheetMirrorRow = sync.prepareSheetMirrorRow;
    recordSheetMirror = sync.recordSheetMirror;
  });

  afterAll(async () => {
    if (!db) return;
    await db.$transaction(async (tx) => {
      const videos = await tx.video.findMany({
        where: { videoId: { in: videoIds } },
        select: { id: true },
      });
      const ids = videos.map(({ id }) => id);
      if (ids.length) {
        await tx.sheetRowSync.deleteMany({ where: { videoId: { in: ids } } });
        await tx.syncConflict.deleteMany({ where: { videoId: { in: ids } } });
        await tx.thumbnail.deleteMany({ where: { videoId: { in: ids } } });
        await tx.approvalEvent.deleteMany({ where: { videoId: { in: ids } } });
        await tx.video.deleteMany({ where: { id: { in: ids } } });
      }
      if (driveIds.length) await tx.video.deleteMany({ where: { driveFileId: { in: driveIds } } });
      if (faceIds.length) await tx.face.deleteMany({ where: { id: { in: faceIds } } });
    });
    await db.$disconnect();
  });

  it.skipIf(!runWithDatabase)(
    'treats an unknown placeholder row as a conflict and never creates or mutates a video',
    async () => {
      const client = db;
      const reconcile = reconcileSheetRow;
      if (!client || !reconcile) throw new Error('Test database did not initialize');
      const videoId = `GCS-${Date.now()}${Math.floor(Math.random() * 1000)}`;
      videoIds.push(videoId);
      const result = await reconcile(client, {
        spreadsheetId: 'qa-sheet-placeholder',
        row: { videoId },
        actorId: 'qa-test',
      });
      expect(result).toMatchObject({ applied: [], conflicts: ['videoId'] });
      expect(await client.video.findUnique({ where: { videoId } })).toBeNull();
      expect(
        await client.syncConflict.count({
          where: { sourceKey: `qa-sheet-placeholder:${videoId}` },
        }),
      ).toBe(1);
    },
  );

  it.skipIf(!runWithDatabase)(
    'keeps omitted human fields intact on a partial row and acknowledges a mirror idempotently',
    async () => {
      const client = db;
      const reconcile = reconcileSheetRow;
      const prepare = prepareSheetMirrorRow;
      const record = recordSheetMirror;
      if (!client || !reconcile || !prepare || !record)
        throw new Error('Test database did not initialize');

      const token = crypto.randomUUID();
      const videoId = `GCS-${Date.now()}${Math.floor(Math.random() * 1000)}`;
      const driveFileId = `qa-sheet-${token}`;
      videoIds.push(videoId);
      driveIds.push(driveFileId);
      const face = await client.face.create({ data: { name: `qa-sheet-${token}` } });
      faceIds.push(face.id);
      const video = await client.video.create({
        data: {
          videoId,
          driveFileId,
          faceId: face.id,
          title: 'Existing title stays',
          workflowStatus: 'WAITING_APPROVAL',
          approvalStatus: 'PENDING',
        },
      });

      const result = await reconcile(client, {
        spreadsheetId: 'qa-sheet-partial',
        row: { videoId },
        actorId: 'qa-test',
      });
      expect(result.applied).toEqual([]);
      const unchanged = await client.video.findUniqueOrThrow({ where: { id: video.id } });
      expect(unchanged).toMatchObject({
        title: 'Existing title stays',
        faceId: face.id,
        approvalStatus: 'PENDING',
        workflowStatus: 'WAITING_APPROVAL',
      });

      const mirror = await prepare(client, videoId);
      const input = {
        spreadsheetId: 'qa-sheet-partial',
        videoId,
        rowVersion: mirror.rowVersion,
        contentHash: mirror.contentHash,
      };
      await expect(record(client, input)).resolves.toBe(true);
      await expect(record(client, input)).resolves.toBe(true);
      expect(
        await client.sheetRowSync.count({
          where: { spreadsheetId: input.spreadsheetId, videoId: video.id },
        }),
      ).toBe(1);
    },
  );
});
