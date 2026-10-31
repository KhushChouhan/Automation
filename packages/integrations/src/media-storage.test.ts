import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalMediaStorage } from './media-storage.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('local MediaStorage contract', () => {
  it('streams, heads, signs and idempotently deletes deterministic objects across instances', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'gcs-media-'));
    directories.push(directory);
    const first = new LocalMediaStorage(directory);
    const uploaded = await first.upload({
      key: 'reels/GCS-0021/schedule/video.mp4',
      body: Readable.from(Buffer.alloc(1024 * 1024 + 7, 1)),
      contentType: 'video/mp4',
    });
    expect(uploaded.sizeBytes).toBe(1024 * 1024 + 7);
    const restarted = new LocalMediaStorage(directory);
    expect((await restarted.head(uploaded.key))?.checksum).toBe(uploaded.checksum);
    const signed = await restarted.createReadUrl(uploaded.key, 600);
    expect(signed.url).not.toContain('credential');
    expect(signed.expiresAt.getTime()).toBeGreaterThan(Date.now());
    await restarted.delete(uploaded.key);
    await restarted.delete(uploaded.key);
    expect(await restarted.head(uploaded.key)).toBeNull();
  });

  it('rejects path traversal and missing objects', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'gcs-media-'));
    directories.push(directory);
    const storage = new LocalMediaStorage(directory);
    await expect(
      storage.upload({ key: '../outside', body: new Uint8Array([1]), contentType: 'video/mp4' }),
    ).rejects.toThrow('escapes');
    await expect(storage.createReadUrl('missing', 600)).rejects.toThrow('not found');
  });
});
