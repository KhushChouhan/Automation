import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { candidateVideoId } from '../src/thumbnails.js';
import type { reconcileDriveThumbnails as ReconcileDriveThumbnails } from '../src/thumbnails.js';

const testDatabaseUrl = process.env['TEST_DATABASE_URL'];
const runWithDatabase = Boolean(testDatabaseUrl);

describe('Drive thumbnail matching invariants', () => {
  let db: PrismaClient | undefined;
  let reconcileDriveThumbnails: typeof ReconcileDriveThumbnails | undefined;
  const videoIds: string[] = [];
  const driveFileIds: string[] = [];

  beforeAll(async () => {
    if (!testDatabaseUrl) return;
    const [{ PrismaClient }, thumbnails] = await Promise.all([
      import('@prisma/client'),
      import('../src/thumbnails.js'),
    ]);
    db = new PrismaClient({ datasources: { db: { url: testDatabaseUrl } } });
    reconcileDriveThumbnails = thumbnails.reconcileDriveThumbnails;
  });

  afterAll(async () => {
    if (!db) return;
    await db.$transaction(async (tx) => {
      await tx.unmatchedThumbnail.deleteMany({ where: { driveFileId: { in: driveFileIds } } });
      const videos = await tx.video.findMany({
        where: { videoId: { in: videoIds } },
        select: { id: true },
      });
      const ids = videos.map(({ id }) => id);
      if (ids.length) {
        await tx.syncConflict.deleteMany({ where: { videoId: { in: ids } } });
        await tx.thumbnail.deleteMany({ where: { videoId: { in: ids } } });
        await tx.video.deleteMany({ where: { id: { in: ids } } });
      }
    });
    await db.$disconnect();
  });

  it('uses explicit Video IDs, normalizes case, and leaves ambiguous names unmatched', () => {
    expect(candidateVideoId({ fileId: 'f1', name: 'gcs-0007-cover.jpg' })).toBe('GCS-0007');
    expect(candidateVideoId({ fileId: 'f2', name: 'cover-GCS-0007.jpg' })).toBeNull();
    expect(
      candidateVideoId({ fileId: 'f3', name: 'GCS-0007-a.jpg', videoId: 'not-an-id' }),
    ).toBeNull();
  });

  it.skipIf(!runWithDatabase)(
    'attaches one unambiguous thumbnail idempotently and records competing/unmatched assets',
    async () => {
      const client = db;
      const reconcile = reconcileDriveThumbnails;
      if (!client || !reconcile) throw new Error('Test database did not initialize');
      const token = crypto.randomUUID();
      const attachedId = `GCS-${Date.now()}1`;
      const conflictId = `GCS-${Date.now()}2`;
      videoIds.push(attachedId, conflictId);
      const attachedFileId = `qa-thumbnail-${token}-attached`;
      const conflictFileA = `qa-thumbnail-${token}-a`;
      const conflictFileB = `qa-thumbnail-${token}-b`;
      const unrelatedFile = `qa-thumbnail-${token}-unrelated`;
      driveFileIds.push(attachedFileId, conflictFileA, conflictFileB, unrelatedFile);
      await client.video.create({ data: { videoId: attachedId, workflowStatus: 'WAITING_FACE' } });
      await client.video.create({ data: { videoId: conflictId, workflowStatus: 'WAITING_FACE' } });

      const first = await reconcile(
        client,
        [
          { fileId: attachedFileId, name: `${attachedId}_cover.jpg`, mimeType: 'image/jpeg' },
          { fileId: conflictFileA, name: `${conflictId}_a.jpg` },
          { fileId: conflictFileB, name: `${conflictId}_b.jpg` },
          { fileId: unrelatedFile, name: 'cover.jpg' },
        ],
        'qa-test',
      );
      expect(first.attached).toEqual([attachedFileId]);
      expect(first.conflicts).toEqual([conflictId]);
      expect(first.unmatched).toEqual(
        expect.arrayContaining([conflictFileA, conflictFileB, unrelatedFile]),
      );

      const second = await reconcile(
        client,
        [{ fileId: attachedFileId, name: `${attachedId}_cover.jpg`, mimeType: 'image/jpeg' }],
        'qa-test',
      );
      expect(second.attached).toEqual([]);
      expect(await client.thumbnail.count({ where: { driveFileId: attachedFileId } })).toBe(1);
      expect(
        await client.unmatchedThumbnail.count({ where: { driveFileId: { in: driveFileIds } } }),
      ).toBe(3);
      expect(
        await client.syncConflict.count({ where: { sourceKey: conflictId, field: 'thumbnail' } }),
      ).toBe(1);
    },
  );
});
