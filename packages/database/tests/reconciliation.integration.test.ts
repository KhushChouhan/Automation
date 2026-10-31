import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type { discoverVideo as Discover } from '../src/videos.js';
import type {
  reconcileSheetRows as ReconcileRows,
  prepareSheetMirrorRow as PrepareMirror,
} from '../src/sheet-sync.js';
import type { reconcileDriveThumbnails as ReconcileThumbnails } from '../src/thumbnails.js';

const testDatabaseUrl = process.env['TEST_DATABASE_URL'];

describe('Google reconciliation persistence', () => {
  let db: PrismaClient | undefined;
  let discover: typeof Discover;
  let rows: typeof ReconcileRows;
  let mirror: typeof PrepareMirror;
  let thumbnails: typeof ReconcileThumbnails;
  const tag = crypto.randomUUID();
  const spreadsheetId = `qa-sheet-${tag}`;
  const driveFileId = `qa-video-${tag}`;
  const thumbFileId = `qa-thumbnail-${tag}`;
  let videoId: string;
  let faceId: string;

  beforeAll(async () => {
    if (!testDatabaseUrl) return;
    const [{ PrismaClient }, videos, sheet, thumbnail] = await Promise.all([
      import('@prisma/client'),
      import('../src/videos.js'),
      import('../src/sheet-sync.js'),
      import('../src/thumbnails.js'),
    ]);
    db = new PrismaClient({ datasources: { db: { url: testDatabaseUrl } } });
    discover = videos.discoverVideo;
    rows = sheet.reconcileSheetRows;
    mirror = sheet.prepareSheetMirrorRow;
    thumbnails = thumbnail.reconcileDriveThumbnails;
    const face = await db.face.create({ data: { name: `qa-face-${tag}` } });
    faceId = face.id;
    const discovered = await discover(db, {
      driveFileId,
      sourceSizeBytes: '123456',
      sourceCreatedTime: '2026-10-25T10:00:00.000Z',
      sourceModifiedTime: '2026-10-26T10:00:00.000Z',
    });
    videoId = discovered.videoId;
    expect(discovered.sourceSizeBytes).toBe(123456n);
    expect(discovered.sourceCreatedTime?.toISOString()).toBe('2026-10-25T10:00:00.000Z');
    expect(discovered.sourceModifiedTime?.toISOString()).toBe('2026-10-26T10:00:00.000Z');
  });

  afterAll(async () => {
    if (!db) return;
    const video = await db.video.findUnique({ where: { videoId } });
    if (video) {
      await db.sheetRowSync.deleteMany({ where: { videoId: video.id } });
      await db.syncConflict.deleteMany({ where: { videoId: video.id } });
      await db.syncConflict.deleteMany({ where: { sourceKey: { startsWith: spreadsheetId } } });
      await db.unmatchedThumbnail.deleteMany({ where: { driveFileId: thumbFileId } });
      await db.thumbnail.deleteMany({ where: { videoId: video.id } });
      await db.video.delete({ where: { id: video.id } });
    }
    await db.face.deleteMany({ where: { id: faceId } });
    await db.$disconnect();
  });

  it.skipIf(!testDatabaseUrl)(
    'keeps a placeholder row inert and rejects duplicate IDs',
    async () => {
      const client = db!;
      const first = await rows(client, {
        spreadsheetId,
        actorId: 'sheet-approver',
        rows: [{ videoId, title: '' }],
      });
      expect(first.results[0]?.applied).toEqual([]);
      expect((await client.video.findUniqueOrThrow({ where: { videoId } })).title).toBeNull();
      const duplicate = await rows(client, {
        spreadsheetId,
        actorId: 'sheet-approver',
        rows: [
          { videoId, title: 'One' },
          { videoId, title: 'Two' },
        ],
      });
      expect(duplicate.duplicateIds).toEqual([videoId]);
      expect((await client.video.findUniqueOrThrow({ where: { videoId } })).title).toBeNull();
    },
  );

  it.skipIf(!testDatabaseUrl)(
    'imports validated inputs and protects mirrored system fields',
    async () => {
      const client = db!;
      const asset = { fileId: thumbFileId, name: `${videoId}-cover.jpg`, mimeType: 'image/jpeg' };
      expect((await thumbnails(client, [asset], 'design')).attached).toEqual([thumbFileId]);
      const imported = await rows(client, {
        spreadsheetId,
        actorId: 'sheet-approver',
        rows: [{ videoId, title: 'Site update', faceId, workflowStatus: 'POSTED' }],
      });
      expect(imported.results[0]?.applied).toEqual(['title', 'faceId']);
      expect(imported.results[0]?.repairFields).toContain('workflowStatus');
      const video = await client.video.findUniqueOrThrow({ where: { videoId } });
      expect(video.workflowStatus).toBe('WAITING_APPROVAL');
      expect(video.approvalStatus).toBe('PENDING');
      expect(
        await client.syncConflict.count({
          where: {
            source: 'SHEET_SYSTEM_FIELD',
            videoId: video.id,
            field: 'workflowStatus',
            reason: 'SYSTEM_FIELD_MISMATCH',
          },
        }),
      ).toBe(1);
      expect(
        await client.auditLog.count({
          where: { entityId: video.id, action: 'SYNC_CONFLICT' },
        }),
      ).toBe(1);
      const outgoing = await mirror(client, videoId);
      expect(outgoing.workflowStatus).toBe('WAITING_APPROVAL');
      expect(outgoing.instagramMediaId).toBe('');
      expect(outgoing.thumbnailDriveFileId).toBe(thumbFileId);
    },
  );
});
