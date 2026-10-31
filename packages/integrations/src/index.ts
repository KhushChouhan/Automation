export interface DriveVideoAsset {
  fileId: string;
  name: string;
  mimeType: string;
  size?: number;
  createdTime?: string;
  modifiedTime?: string;
  webViewLink?: string;
  checksum?: string;
}

export interface GoogleDriveAdapter {
  listVideoAssets(folderId: string): Promise<DriveVideoAsset[]>;
  getDownloadUrl(fileId: string): Promise<string | null>;
}

export interface SheetVideoRow {
  videoId: string;
  title?: string;
  faceId?: string;
  videoLink?: string;
  thumbnailLink?: string;
  approvalStatus?: string;
  status?: string;
  selectedDate?: string;
  scheduledDate?: string;
  scheduledTime?: string;
  postedDate?: string;
  instagramMediaId?: string;
  instagramPermalink?: string;
  caption?: string;
  hashtags?: string;
  error?: string;
  retryCount?: number;
  notes?: string;
  rowVersion?: string;
}

export interface GoogleSheetsAdapter {
  readVideoRows(spreadsheetId: string, range: string): Promise<SheetVideoRow[]>;
  mirrorVideoRows(spreadsheetId: string, rows: SheetVideoRow[]): Promise<void>;
}

export interface CaptionRequest {
  title: string;
  brandContext?: string;
  promptVersion: string;
}

export interface CaptionDraft {
  caption: string;
  hashtags: string[];
  cta: string;
}

export interface OpenAIAdapter {
  generateCaption(request: CaptionRequest): Promise<CaptionDraft>;
}

export interface InstagramPublishRequest {
  videoUrl: string;
  caption: string;
  thumbnailUrl?: string;
}

export interface InstagramPublishResult {
  mediaId: string;
  permalink?: string;
  provider: 'instagram' | 'fake';
}

export interface InstagramAdapter {
  publishReel(request: InstagramPublishRequest): Promise<InstagramPublishResult>;
}

/** Thrown by deliberately non-publishing fakes if code attempts a publish. */
export class PublishingDisabledError extends Error {
  constructor() {
    super('Instagram publishing is disabled in this environment');
    this.name = 'PublishingDisabledError';
  }
}

export class FakeGoogleDriveAdapter implements GoogleDriveAdapter {
  constructor(private readonly assets: DriveVideoAsset[] = []) {}
  listVideoAssets(folderId: string): Promise<DriveVideoAsset[]> {
    void folderId;
    return Promise.resolve(structuredClone(this.assets));
  }
  getDownloadUrl(fileId: string): Promise<string | null> {
    return Promise.resolve(
      this.assets.some((asset) => asset.fileId === fileId)
        ? `https://fake.invalid/download/${encodeURIComponent(fileId)}`
        : null,
    );
  }
}

export class FakeGoogleSheetsAdapter implements GoogleSheetsAdapter {
  readonly mirrored: SheetVideoRow[][] = [];
  constructor(private readonly rows: SheetVideoRow[] = []) {}
  readVideoRows(spreadsheetId: string, range: string): Promise<SheetVideoRow[]> {
    void spreadsheetId;
    void range;
    return Promise.resolve(structuredClone(this.rows));
  }
  mirrorVideoRows(spreadsheetId: string, rows: SheetVideoRow[]): Promise<void> {
    void spreadsheetId;
    this.mirrored.push(structuredClone(rows));
    return Promise.resolve();
  }
}

export class FakeOpenAIAdapter implements OpenAIAdapter {
  generateCaption(request: CaptionRequest): Promise<CaptionDraft> {
    return Promise.resolve({ caption: request.title, hashtags: [], cta: 'Learn more.' });
  }
}

export class FakeInstagramAdapter implements InstagramAdapter {
  publishReel(request: InstagramPublishRequest): Promise<InstagramPublishResult> {
    void request;
    return Promise.reject(new PublishingDisabledError());
  }
}

export class FakeMediaStorage implements MediaStorage {
  readonly provider = 'fake';
  readonly bucket = 'fake';
  readonly assets = new Map<string, MediaObjectMetadata>();
  async upload(input: MediaUploadInput): Promise<MediaObjectMetadata> {
    const bytes =
      input.body instanceof Uint8Array
        ? input.body.byteLength
        : await (async (stream: Readable) => {
            let size = 0;
            for await (const chunk of stream)
              size += Buffer.isBuffer(chunk)
                ? chunk.byteLength
                : Buffer.byteLength(chunk as Uint8Array);
            return size;
          })(input.body);
    const asset = { key: input.key, contentType: input.contentType, sizeBytes: bytes };
    this.assets.set(input.key, asset);
    return asset;
  }
  head(key: string): Promise<MediaObjectMetadata | null> {
    return Promise.resolve(this.assets.get(key) ?? null);
  }
  createReadUrl(key: string, ttlSeconds: number): Promise<TemporaryReadUrl> {
    if (!this.assets.has(key)) return Promise.reject(new Error('Media object not found'));
    return Promise.resolve({
      url: `https://fake.invalid/media/${encodeURIComponent(key)}`,
      expiresAt: new Date(Date.now() + ttlSeconds * 1_000),
    });
  }
  delete(key: string): Promise<void> {
    this.assets.delete(key);
    return Promise.resolve();
  }
}

export {
  GoogleDriveV3Adapter,
  GoogleSheetsV4Adapter,
  GoogleIntegrationError,
  createGoogleAuth,
  createGoogleDriveClientFromEnv,
  createGoogleSheetsClientFromEnv,
  googleCredentialConfigFromEnv,
  googleEnvironmentSchema,
  getGoogleAuthStatus,
  googleDriveFileIdFromLink,
  classifyGoogleError,
  withGoogleRetry,
  type GoogleCredentialConfig,
  type GoogleFailureCode,
  type GoogleDriveClient,
  type GoogleSheetsClient,
  type GoogleDriveFile,
  type DriveChangePage,
  type SheetPostingHistoryRow,
  type RetryOptions,
} from './google.js';
import type { Readable } from 'node:stream';
import type {
  MediaObjectMetadata,
  MediaStorage,
  MediaUploadInput,
  TemporaryReadUrl,
} from './media-storage.js';

export {
  ContentGenerationError,
  OpenAIContentGenerator,
  OpenAIResponsesPort,
  type ContentGenerationFailure,
  type OpenAIResponsePort,
} from './openai.js';

export { GeminiContentGenerator, GeminiGenerationError, type GeminiFailureCode } from './gemini.js';

export {
  MetaGraphInstagramPublisher,
  MetaIntegrationError,
  MetaPublishingDisabledError,
  META_REQUIRED_PERMISSIONS,
  instagramReelCapabilityMatrix,
  type InstagramAccount,
  type InstagramPublisher,
  type InstagramPublisherConfiguration,
  type InstagramPublishingCapability,
  type MetaErrorMetadata,
  type MetaFailureCode,
  type MetaPermissionState,
  type MetaRequiredPermission,
  type MetaTokenExpiryState,
  type PermissionCheck,
  type PublishingLimitStatus,
  type PublishedInstagramMedia,
  type ReelContainerInput,
  type ReelContainerStatus,
  type TokenExpiryCheck,
} from './meta-instagram.js';

export {
  CloudinaryMediaStorage,
  CloudinaryStorageError,
  LocalMediaStorage,
  R2MediaStorage,
  type CloudinaryClientPort,
  type CloudinaryMediaStorageConfig,
  type CloudinaryStorageFailureCode,
  type MediaStorage,
  type MediaUploadInput,
  type MediaObjectMetadata,
  type TemporaryReadUrl,
  type R2MediaStorageConfig,
} from './media-storage.js';
