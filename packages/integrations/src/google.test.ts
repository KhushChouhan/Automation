import { describe, expect, it, vi } from 'vitest';
import {
  GoogleDriveV3Adapter,
  GoogleIntegrationError,
  GoogleSheetsV4Adapter,
  googleDriveFileIdFromLink,
  classifyGoogleError,
  createGoogleAuth,
  getGoogleAuthStatus,
  googleCredentialConfigFromEnv,
  withGoogleRetry,
  type GoogleDriveClient,
  type GoogleSheetsClient,
} from './index.js';

describe('Google credential handling', () => {
  it('validates OAuth configuration and reports only safe status fields', () => {
    const env = {
      GOOGLE_CLIENT_ID: 'id',
      GOOGLE_CLIENT_SECRET: 'secret',
      GOOGLE_REFRESH_TOKEN: 'refresh',
      GOOGLE_SHEET_ID: 'sheet-1',
      GOOGLE_VIDEO_FOLDER_ID: 'videos-1',
      GOOGLE_THUMBNAIL_FOLDER_ID: 'thumbs-1',
      GOOGLE_ARCHIVE_FOLDER_ID: 'archive-1',
    };
    expect(googleCredentialConfigFromEnv(env)).toEqual({
      type: 'oauth',
      clientId: 'id',
      clientSecret: 'secret',
      refreshToken: 'refresh',
    });
    expect(getGoogleAuthStatus(env)).toEqual({ configured: true, authType: 'oauth' });
    expect(getGoogleAuthStatus({ GOOGLE_CLIENT_ID: 'id' })).toEqual({
      configured: false,
      authType: null,
    });
  });

  it('accepts service account JSON and rejects malformed credential payloads without exposing them', () => {
    expect(() => createGoogleAuth({ type: 'service_account', json: '{' })).toThrow(
      'Google service account JSON is invalid',
    );
    expect(() =>
      googleCredentialConfigFromEnv({
        GOOGLE_CLIENT_ID: 'secret-value',
      }),
    ).toThrow('Google credentials are incomplete');
  });
});

describe('Drive v3 adapter', () => {
  it('lists only direct children of the supplied folder using minimal metadata and pages results', async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce({
        data: {
          nextPageToken: 'next',
          files: [
            {
              id: 'v1',
              name: 'one.mp4',
              mimeType: 'video/mp4',
              size: '314',
              createdTime: '2026-10-25T12:00:00.000Z',
              md5Checksum: 'hash',
              webViewLink: 'https://drive.test/v1',
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        data: { files: [{ id: 't1', name: 'cover.jpg', mimeType: 'image/jpeg' }] },
      });
    const client = {
      files: { list },
      changes: { getStartPageToken: vi.fn(), list: vi.fn() },
    } as unknown as GoogleDriveClient;
    const adapter = new GoogleDriveV3Adapter(client, {
      sleep: vi.fn().mockResolvedValue(undefined),
    });
    expect(await adapter.listVideoAssets('folder-id')).toEqual([
      {
        fileId: 'v1',
        name: 'one.mp4',
        mimeType: 'video/mp4',
        size: 314,
        createdTime: '2026-10-25T12:00:00.000Z',
        webViewLink: 'https://drive.test/v1',
        checksum: 'hash',
      },
    ]);
    expect(list).toHaveBeenCalledTimes(2);
    expect(list.mock.calls[0]?.[0]).toMatchObject({
      q: "'folder-id' in parents and trashed = false",
      fields:
        'nextPageToken,files(id,name,mimeType,size,createdTime,webViewLink,md5Checksum,modifiedTime,parents)',
    });
    expect(list.mock.calls[1]?.[0]).toMatchObject({ pageToken: 'next' });
  });

  it('exposes cursor operations and keeps archive moves disabled by default', async () => {
    const getStartPageToken = vi.fn().mockResolvedValue({ data: { startPageToken: 'cursor-1' } });
    const list = vi.fn().mockResolvedValue({
      data: {
        newStartPageToken: 'cursor-2',
        changes: [
          { fileId: 'v1', file: { id: 'v1', name: 'new.mp4', mimeType: 'video/mp4' } },
          { fileId: 'gone', removed: true },
        ],
      },
    });
    const client = {
      files: { list: vi.fn(), get: vi.fn(), update: vi.fn() },
      changes: { getStartPageToken, list },
    } as unknown as GoogleDriveClient;
    const adapter = new GoogleDriveV3Adapter(client);
    await expect(adapter.getStartPageToken()).resolves.toBe('cursor-1');
    await expect(adapter.listChanges('cursor-1')).resolves.toMatchObject({
      newStartPageToken: 'cursor-2',
      changes: [{ fileId: 'v1' }],
    });
    await expect(adapter.moveFileToArchive('v1', 'archive')).rejects.toMatchObject({
      code: 'PERMANENT',
    });
  });
});

describe('Sheets v4 adapter', () => {
  it('normalizes supported Google Drive link shapes without accepting foreign links', () => {
    expect(googleDriveFileIdFromLink('https://drive.google.com/file/d/abc_DEF-123456/view')).toBe(
      'abc_DEF-123456',
    );
    expect(googleDriveFileIdFromLink('https://drive.google.com/open?id=abc_DEF-123456')).toBe(
      'abc_DEF-123456',
    );
    expect(googleDriveFileIdFromLink('https://example.test/file/d/abc_DEF-123456')).toBeUndefined();
  });

  it('repairs a blank-ID row in place when its Drive link matches a discovered video', async () => {
    const valuesGet = vi.fn().mockResolvedValue({
      data: {
        values: [['', '', 'https://drive.google.com/file/d/abc_DEF-123456/view']],
      },
    });
    const batchUpdate = vi.fn().mockResolvedValue({ data: {} });
    const client = {
      spreadsheets: { get: vi.fn(), values: { get: valuesGet, batchUpdate } },
    } as unknown as GoogleSheetsClient;
    const adapter = new GoogleSheetsV4Adapter(client);

    await adapter.mirrorVideoRows('sheet', [
      {
        videoId: 'GCS-42',
        videoLink: 'https://drive.google.com/file/d/abc_DEF-123456/view',
        status: 'WAITING_FACE',
      },
    ]);

    const writes = (
      batchUpdate.mock.calls[0]?.[0] as {
        requestBody: { data: Array<{ range: string }> };
      }
    ).requestBody.data;
    expect(writes.map(({ range }) => range)).toEqual([
      'Videos!A2:A2',
      'Videos!C2:C2',
      'Videos!E2:E2',
      'Videos!G2:Q2',
    ]);
  });

  it('reads bounded rows, exposes spreadsheet metadata, and writes video and posting history mirrors', async () => {
    const get = vi.fn().mockResolvedValue({
      data: {
        spreadsheetId: 'sheet',
        properties: { title: 'Ops' },
        sheets: [{ properties: { sheetId: 1, title: 'Videos' } }],
      },
    });
    const header = [
      'Video ID',
      'Face ID',
      'Video Link',
      'Title',
      'Thumbnail Link',
      'Approval',
      'Status',
      'Selected Date',
      'Scheduled Date',
      'Scheduled Time',
      'Posted Date',
      'Instagram Media ID',
      'Instagram Permalink',
      'Caption',
      'Hashtags',
      'Error',
      'Retry Count',
      'Notes',
    ];
    const valuesGet = vi.fn().mockImplementation(({ range }: { range: string }) =>
      Promise.resolve({
        data: {
          values:
            range === 'Videos!A2:C10001' || range === 'Posting History!B2:B10001'
              ? [['GCS-1']]
              : [
                  header,
                  [
                    'GCS-1',
                    'FACE-1',
                    'https://drive.test/video',
                    'A title',
                    'https://drive.test/cover',
                    'APPROVED',
                    'READY',
                    '',
                    '',
                    '',
                    '',
                    '',
                    '',
                    '',
                    '',
                    '',
                    0,
                    '',
                  ],
                  ['', '', '', 'Title without an ID'],
                  ['', ''],
                ],
        },
      }),
    );
    const batchUpdate = vi.fn().mockResolvedValue({ data: {} });
    const client = {
      spreadsheets: { get, values: { get: valuesGet, batchUpdate } },
    } as unknown as GoogleSheetsClient;
    const adapter = new GoogleSheetsV4Adapter(client);
    await expect(adapter.getMetadata('sheet')).resolves.toMatchObject({
      title: 'Ops',
      sheets: [{ title: 'Videos' }],
    });
    await expect(adapter.readVideoRows('sheet', 'Videos!A1:R100')).resolves.toEqual([
      {
        videoId: 'GCS-1',
        faceId: 'FACE-1',
        videoLink: 'https://drive.test/video',
        title: 'A title',
        thumbnailLink: 'https://drive.test/cover',
        approvalStatus: 'APPROVED',
        status: 'READY',
        retryCount: 0,
      },
      { videoId: '', title: 'Title without an ID' },
    ]);
    await adapter.mirrorVideoRows('sheet', [
      {
        videoId: 'GCS-1',
        title: 'A title',
        faceId: 'HUMAN-FACE',
        approvalStatus: 'APPROVED',
        videoLink: 'https://drive.test/new-video',
        thumbnailLink: 'https://drive.test/new-cover',
        status: 'READY',
      },
      {
        videoId: 'GCS-2',
        title: 'Never write human title',
        faceId: 'HUMAN-FACE-2',
        approvalStatus: 'PENDING',
        videoLink: 'https://drive.test/video-2',
        thumbnailLink: 'https://drive.test/cover-2',
        status: 'WAITING_APPROVAL',
      },
    ]);
    await adapter.mirrorPostingHistory('sheet', [
      {
        date: '2026-10-27',
        videoId: 'GCS-1',
        faceId: 'FACE-1',
        scheduledTime: '19:00',
        postedTime: '20:00',
        instagramMediaId: 'm1',
        permalink: 'https://instagram.test/m1',
        result: 'POSTED',
      },
    ]);
    await adapter.mirrorPostingHistory('sheet', [
      {
        date: '2026-10-27',
        videoId: 'GCS-1',
        faceId: 'FACE-1',
        scheduledTime: '19:00',
        postedTime: '20:00',
        instagramMediaId: 'm1',
        permalink: 'https://instagram.test/m1',
        result: 'POSTED',
      },
    ]);
    expect(batchUpdate).toHaveBeenCalledTimes(3);
    const videoWrite = batchUpdate.mock.calls[0]?.[0] as {
      requestBody: { data: Array<{ range: string; values: unknown[][] }> };
    };
    expect(videoWrite.requestBody.data.map(({ range }) => range)).toEqual([
      'Videos!C2:C2',
      'Videos!E2:E2',
      'Videos!G2:Q2',
      'Videos!A3:A3',
      'Videos!C3:C3',
      'Videos!E3:E3',
      'Videos!G3:Q3',
    ]);
    expect(videoWrite.requestBody.data.some(({ range }) => /Videos![BDF]/.test(range))).toBe(false);
    expect(
      videoWrite.requestBody.data.find(({ range }) => range === 'Videos!A3:A3')?.values,
    ).toEqual([['GCS-2']]);
    expect(
      (batchUpdate.mock.calls[1]?.[0] as { requestBody: { data: Array<{ range: string }> } })
        .requestBody.data[0]?.range,
    ).toBe('Posting History!A2:H2');
    expect(
      (batchUpdate.mock.calls[2]?.[0] as { requestBody: { data: Array<{ range: string }> } })
        .requestBody.data[0]?.range,
    ).toBe('Posting History!A2:H2');
    await expect(adapter.readRange('sheet', 'Videos!A:E')).rejects.toBeInstanceOf(
      GoogleIntegrationError,
    );
  });
});

describe('Google retry and error mapping', () => {
  it('maps auth, permission, not found, validation, rate limits, transient, and permanent failures', () => {
    expect(classifyGoogleError({ response: { status: 401 } }).code).toBe('AUTH');
    expect(classifyGoogleError({ response: { status: 403 } }).code).toBe('PERMISSION');
    expect(classifyGoogleError({ response: { status: 404 } }).code).toBe('NOT_FOUND');
    expect(classifyGoogleError({ response: { status: 400 } }).code).toBe('VALIDATION');
    expect(classifyGoogleError({ response: { status: 429 } }).code).toBe('RATE_LIMIT');
    expect(classifyGoogleError({ response: { status: 503 } }).code).toBe('TRANSIENT');
    expect(classifyGoogleError({ response: { status: 409 } }).code).toBe('PERMANENT');
  });

  it('retries bounded transient failures with injected jitter and does not retry permissions', async () => {
    const operation = vi
      .fn()
      .mockRejectedValueOnce({ response: { status: 503 } })
      .mockResolvedValue('ok');
    const sleep = vi.fn().mockResolvedValue(undefined);
    await expect(
      withGoogleRetry(operation, { maxAttempts: 2, baseDelayMs: 10, random: () => 0.5, sleep }),
    ).resolves.toBe('ok');
    expect(operation).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(5);
    const denied = vi.fn().mockRejectedValue({ response: { status: 403 } });
    await expect(withGoogleRetry(denied, { sleep })).rejects.toMatchObject({ code: 'PERMISSION' });
    expect(denied).toHaveBeenCalledTimes(1);
  });
});
