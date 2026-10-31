import { Readable, Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  CloudinaryMediaStorage,
  CloudinaryStorageError,
  type CloudinaryClientPort,
} from './media-storage.js';

type StoredObject = {
  public_id: string;
  resource_type: string;
  format: string;
  bytes: number;
  etag: string;
};

class FakeCloudinaryClient implements CloudinaryClientPort {
  readonly objects = new Map<string, StoredObject>();
  readonly uploadOptions: Array<Record<string, unknown>> = [];
  readonly urlOptions: Array<Record<string, unknown>> = [];
  streamChunks = 0;
  uploadError: unknown;

  uploadStream(
    options: Record<string, unknown>,
    callback: (error?: unknown, result?: StoredObject) => void,
  ): Writable {
    this.uploadOptions.push(options);
    let bytes = 0;
    return new Writable({
      write: (chunk: Buffer, _encoding, done) => {
        this.streamChunks += 1;
        bytes += chunk.byteLength;
        done();
      },
      final: (done) => {
        if (this.uploadError) callback(this.uploadError);
        else {
          const publicId = String(options['public_id']);
          const format = publicId.endsWith('/thumbnail') ? 'jpg' : 'mp4';
          const stored = {
            public_id: publicId,
            resource_type: String(options['resource_type']),
            format,
            bytes,
            etag: `etag-${bytes}`,
          };
          this.objects.set(`${stored.resource_type}:${publicId}`, stored);
          callback(undefined, stored);
        }
        done();
      },
    });
  }

  resource(publicId: string, options: Record<string, unknown>): Promise<StoredObject> {
    const result = this.objects.get(`${String(options['resource_type'])}:${publicId}`);
    return result
      ? Promise.resolve(result)
      : Promise.reject(Object.assign(new Error('not found'), { http_code: 404 }));
  }

  destroy(publicId: string, options: Record<string, unknown>): Promise<{ result?: string }> {
    const deleted = this.objects.delete(`${String(options['resource_type'])}:${publicId}`);
    return Promise.resolve({ result: deleted ? 'ok' : 'not found' });
  }

  privateDownloadUrl(publicId: string, format: string, options: Record<string, unknown>): string {
    this.urlOptions.push(options);
    return `https://delivery.invalid/${publicId}.${format}?signed=redacted`;
  }
}

function storage(client = new FakeCloudinaryClient()) {
  return {
    client,
    storage: new CloudinaryMediaStorage(
      { cloudName: 'test-cloud', apiKey: 'test-key', apiSecret: 'test-secret' },
      client,
    ),
  };
}

describe('Cloudinary MediaStorage', () => {
  it('streams video using a deterministic private public ID and returns metadata', async () => {
    const fixture = storage();
    const uploaded = await fixture.storage.upload({
      key: 'reels/GCS-0021/schedule-1/video.mp4',
      body: Readable.from([Buffer.alloc(8), Buffer.alloc(13), Buffer.alloc(21)]),
      contentType: 'video/mp4',
    });

    expect(fixture.client.streamChunks).toBeGreaterThan(1);
    expect(fixture.client.uploadOptions[0]).toMatchObject({
      public_id: 'reels/GCS-0021/schedule-1/video',
      resource_type: 'video',
      type: 'private',
      overwrite: true,
      unique_filename: false,
    });
    expect(uploaded).toMatchObject({ sizeBytes: 42, contentType: 'video/mp4' });
    expect(await fixture.storage.head(uploaded.key)).toMatchObject({
      sizeBytes: 42,
      checksum: 'etag-42',
    });
  });

  it('uses image resource type for thumbnails and creates a time-limited private URL', async () => {
    const fixture = storage();
    const key = 'reels/GCS-0021/schedule-1/thumbnail.jpg';
    await fixture.storage.upload({
      key,
      body: new Uint8Array([1, 2, 3]),
      contentType: 'image/jpeg',
    });
    const delivery = await fixture.storage.createReadUrl(key, 600);

    expect(fixture.client.uploadOptions[0]).toMatchObject({
      public_id: 'reels/GCS-0021/schedule-1/thumbnail',
      resource_type: 'image',
      type: 'private',
    });
    expect(fixture.client.urlOptions[0]).toMatchObject({
      resource_type: 'image',
      type: 'private',
    });
    expect(delivery.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(delivery.url).not.toContain('test-secret');
  });

  it('overwrites the same deterministic object and makes cleanup repeat-safe', async () => {
    const fixture = storage();
    const key = 'reels/GCS-0021/schedule-1/video.mp4';
    for (const bytes of [2, 4])
      await fixture.storage.upload({
        key,
        body: Buffer.alloc(bytes),
        contentType: 'video/mp4',
      });

    expect(fixture.client.objects.size).toBe(1);
    expect((await fixture.storage.head(key))?.sizeBytes).toBe(4);
    await fixture.storage.delete(key);
    await fixture.storage.delete(key);
    expect(await fixture.storage.head(key)).toBeNull();
  });

  it('classifies invalid credentials and transient network failures without leaking secrets', async () => {
    const authenticated = storage();
    authenticated.client.uploadError = { http_code: 401, message: 'bad secret' };
    await expect(
      authenticated.storage.upload({
        key: 'reels/GCS-0021/schedule-1/video.mp4',
        body: Buffer.alloc(1),
        contentType: 'video/mp4',
      }),
    ).rejects.toMatchObject({ code: 'AUTHENTICATION', retryable: false });

    const network = storage();
    network.client.uploadError = { code: 'ECONNRESET' };
    await expect(
      network.storage.upload({
        key: 'reels/GCS-0021/schedule-1/video.mp4',
        body: Buffer.alloc(1),
        contentType: 'video/mp4',
      }),
    ).rejects.toMatchObject({ code: 'TRANSIENT', retryable: true });

    expect(() => new CloudinaryMediaStorage({ cloudName: '', apiKey: '', apiSecret: '' })).toThrow(
      CloudinaryStorageError,
    );
  });

  it('treats Cloudinary nested missing-resource responses as a normal absent object', async () => {
    const fixture = storage();
    fixture.client.resource = () =>
      Promise.reject(Object.assign(new Error('not found'), { error: { http_code: 404 } }));

    await expect(fixture.storage.head('reels/GCS-0021/schedule-1/video.mp4')).resolves.toBeNull();
  });
});
