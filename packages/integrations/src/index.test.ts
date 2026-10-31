import { describe, expect, it } from 'vitest';
import {
  FakeGoogleDriveAdapter,
  FakeGoogleSheetsAdapter,
  FakeInstagramAdapter,
  FakeMediaStorage,
  FakeOpenAIAdapter,
  PublishingDisabledError,
} from './index.js';

describe('safe integration fakes', () => {
  it('provides deterministic local Google and OpenAI behavior', async () => {
    const drive = new FakeGoogleDriveAdapter([
      { fileId: 'f1', name: 'reel.mp4', mimeType: 'video/mp4' },
    ]);
    expect(await drive.listVideoAssets('folder')).toHaveLength(1);
    expect(await drive.getDownloadUrl('unknown')).toBeNull();
    const sheets = new FakeGoogleSheetsAdapter([{ videoId: 'GCS-0001', title: 'Title' }]);
    await sheets.mirrorVideoRows('sheet', [{ videoId: 'GCS-0001' }]);
    expect(sheets.mirrored).toHaveLength(1);
    expect(
      await new FakeOpenAIAdapter().generateCaption({ title: 'Title', promptVersion: 'v1' }),
    ).toMatchObject({ caption: 'Title' });
  });

  it('refuses to simulate a real Instagram publish and supports local asset lifecycle', async () => {
    await expect(
      new FakeInstagramAdapter().publishReel({
        videoUrl: 'https://fake.invalid/reel',
        caption: 'x',
      }),
    ).rejects.toBeInstanceOf(PublishingDisabledError);
    const storage = new FakeMediaStorage();
    await storage.upload({
      key: 'a',
      body: new Uint8Array([1, 2, 3]),
      contentType: 'video/mp4',
    });
    expect(storage.assets.has('a')).toBe(true);
    expect((await storage.head('a'))?.sizeBytes).toBe(3);
    expect((await storage.createReadUrl('a', 5)).url).not.toContain('secret');
    await storage.delete('a');
    expect(storage.assets.has('a')).toBe(false);
  });
});
