import { describe, expect, it } from 'vitest';
import { PrismaClient } from '@gcs/database';
import type {
  DriveChangePage,
  DriveVideoAsset,
  GoogleDriveFile,
  SheetPostingHistoryRow,
  SheetVideoRow,
} from '@gcs/integrations';
import { runGoogleSync, type DriveSyncPort, type SheetSyncPort } from './google-sync.js';

const testDatabaseUrl = process.env['TEST_DATABASE_URL'];

class FakeDrive implements DriveSyncPort {
  videos: DriveVideoAsset[] = [];
  thumbnails: GoogleDriveFile[] = [];
  changes: GoogleDriveFile[] = [];

  listVideoAssets(): Promise<DriveVideoAsset[]> {
    return Promise.resolve(structuredClone(this.videos));
  }
  listFolderFiles(): Promise<GoogleDriveFile[]> {
    return Promise.resolve(structuredClone(this.thumbnails));
  }
  getStartPageToken(): Promise<string> {
    return Promise.resolve('cursor-1');
  }
  listChanges(): Promise<DriveChangePage> {
    return Promise.resolve({
      changes: structuredClone(this.changes),
      newStartPageToken: 'cursor-2',
    });
  }
}

class FakeSheet implements SheetSyncPort {
  rows: SheetVideoRow[] = [];
  mirrored: SheetVideoRow[][] = [];
  history: SheetPostingHistoryRow[][] = [];

  readVideoRows(): Promise<SheetVideoRow[]> {
    return Promise.resolve(structuredClone(this.rows));
  }
  readSettings(): Promise<unknown[][]> {
    return Promise.resolve([
      ['Timezone', 'Asia/Kolkata'],
      ['Daily Reel Limit', 2],
      ['Same Face Gap Days', 2],
      ['Slot 1', '19:00'],
      ['Slot 2', '20:00'],
      ['Automation', 'OFF'],
    ]);
  }
  mirrorVideoRows(_spreadsheetId: string, rows: SheetVideoRow[]): Promise<void> {
    this.mirrored.push(structuredClone(rows));
    return Promise.resolve();
  }
  mirrorPostingHistory(_spreadsheetId: string, rows: SheetPostingHistoryRow[]): Promise<void> {
    this.history.push(structuredClone(rows));
    return Promise.resolve();
  }
}

describe('Google sync orchestration', () => {
  it.skipIf(!testDatabaseUrl)(
    'keeps a stable Drive identity and reaches READY only after validated human inputs',
    async () => {
      const db = new PrismaClient({ datasources: { db: { url: testDatabaseUrl! } } });
      const token = crypto.randomUUID();
      const driveFileId = `worker-video-${token}`;
      const thumbnailFileId = `worker-thumb-${token}`;
      const videoFolderId = `video-folder-${token}`;
      const thumbnailFolderId = `thumb-folder-${token}`;
      const spreadsheetId = `sheet-${token}`;
      const drive = new FakeDrive();
      const sheet = new FakeSheet();
      drive.videos = [
        {
          fileId: driveFileId,
          name: 'controlled-smoke.mp4',
          mimeType: 'video/mp4',
          size: 1234,
          createdTime: '2026-10-27T10:00:00.000Z',
          modifiedTime: '2026-10-27T10:01:00.000Z',
        },
      ];

      const first = await runGoogleSync(db, drive, sheet, {
        spreadsheetId,
        videoFolderId,
        thumbnailFolderId,
        actorId: 'worker-test',
      });
      expect(first.videosDiscovered).toBe(1);
      const video = await db.video.findUniqueOrThrow({ where: { driveFileId } });
      expect(video.videoId).toMatch(/^GCS-\d{4,}$/);
      expect(video.sourceSizeBytes).toBe(1234n);
      const face = await db.face.create({ data: { name: `worker-face-${token}` } });

      drive.changes = [
        {
          fileId: thumbnailFileId,
          name: `${video.videoId}.jpg`,
          mimeType: 'image/jpeg',
          parents: [thumbnailFolderId],
        },
      ];
      sheet.rows = [
        {
          // Operators may paste a Drive link before the sync has written its
          // permanent GCS ID. The same sync must repair that row in place.
          videoId: '',
          videoLink: `https://drive.google.com/file/d/${driveFileId}/view`,
          title: 'Human controlled title',
          faceId: face.id,
          approvalStatus: 'APPROVED',
          status: 'POSTED',
        },
      ];
      const second = await runGoogleSync(db, drive, sheet, {
        spreadsheetId,
        videoFolderId,
        thumbnailFolderId,
        actorId: 'worker-test',
      });
      expect(second.thumbnailsMatched).toBe(1);
      expect(second.sheetConflicts).toBe(0);
      const ready = await db.video.findUniqueOrThrow({
        where: { driveFileId },
        include: { thumbnail: true },
      });
      expect(ready).toMatchObject({
        id: video.id,
        videoId: video.videoId,
        title: 'Human controlled title',
        faceId: face.id,
        approvalStatus: 'APPROVED',
        workflowStatus: 'READY',
      });
      expect(ready.thumbnail?.driveFileId).toBe(thumbnailFileId);
      expect(sheet.mirrored.at(-1)?.find((row) => row.videoId === video.videoId)).toMatchObject({
        videoId: video.videoId,
        status: 'READY',
      });
      expect(
        await db.syncCursor.findUnique({
          where: {
            source_accountKey: {
              source: 'GOOGLE_DRIVE_CHANGES',
              accountKey: `${videoFolderId}:${thumbnailFolderId}`,
            },
          },
        }),
      ).toMatchObject({ cursor: 'cursor-2' });
      await db.$disconnect();
    },
    30_000,
  );
});
