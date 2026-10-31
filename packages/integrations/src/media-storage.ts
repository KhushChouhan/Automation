import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform, type Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { v2 as cloudinary } from 'cloudinary';

export interface MediaUploadInput {
  key: string;
  body: Readable | Uint8Array;
  contentType: string;
  contentLength?: number;
  checksum?: string;
}

export interface MediaObjectMetadata {
  key: string;
  contentType: string;
  sizeBytes: number;
  checksum?: string;
}

export interface TemporaryReadUrl {
  url: string;
  expiresAt: Date;
}

export interface MediaStorage {
  readonly provider: string;
  readonly bucket?: string;
  upload(input: MediaUploadInput): Promise<MediaObjectMetadata>;
  head(key: string): Promise<MediaObjectMetadata | null>;
  createReadUrl(key: string, ttlSeconds: number): Promise<TemporaryReadUrl>;
  delete(key: string): Promise<void>;
}

export class LocalMediaStorage implements MediaStorage {
  readonly provider = 'local';
  readonly bucket = 'local-test';
  private readonly root: string;
  constructor(directory = '.local/media-storage') {
    this.root = path.resolve(directory);
  }

  private paths(key: string) {
    const file = path.resolve(this.root, key.replaceAll('/', path.sep));
    if (file !== this.root && !file.startsWith(`${this.root}${path.sep}`))
      throw new Error('Media object key escapes the configured storage directory');
    return { file, metadata: `${file}.metadata.json` };
  }

  async upload(input: MediaUploadInput): Promise<MediaObjectMetadata> {
    if (!input.key.trim() || !input.contentType.trim())
      throw new Error('key and contentType are required');
    const target = this.paths(input.key);
    await mkdir(path.dirname(target.file), { recursive: true });
    const hash = createHash('sha256');
    if (input.body instanceof Uint8Array) {
      hash.update(input.body);
      await writeFile(target.file, input.body);
    } else {
      const hashingStream = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          hash.update(chunk);
          callback(null, chunk);
        },
      });
      await pipeline(input.body, hashingStream, createWriteStream(target.file));
    }
    const info = await stat(target.file);
    const checksum = input.checksum ?? hash.digest('hex');
    const metadata = {
      key: input.key,
      contentType: input.contentType,
      sizeBytes: info.size,
      checksum,
    };
    await writeFile(target.metadata, JSON.stringify(metadata), 'utf8');
    return metadata;
  }
  async head(key: string): Promise<MediaObjectMetadata | null> {
    try {
      return JSON.parse(await readFile(this.paths(key).metadata, 'utf8')) as MediaObjectMetadata;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
  async createReadUrl(key: string, ttlSeconds: number): Promise<TemporaryReadUrl> {
    if (!(await this.head(key))) throw new Error('Media object not found');
    const expiresAt = new Date(Date.now() + ttlSeconds * 1_000);
    return {
      url: `local-media://${encodeURIComponent(key)}?expires=${expiresAt.getTime()}`,
      expiresAt,
    };
  }
  async delete(key: string): Promise<void> {
    const target = this.paths(key);
    await Promise.all([rm(target.file, { force: true }), rm(target.metadata, { force: true })]);
  }
}

type CloudinaryResourceType = 'image' | 'video';

export interface CloudinaryMediaStorageConfig {
  cloudName: string;
  apiKey: string;
  apiSecret: string;
}

type CloudinaryUploadResult = {
  public_id: string;
  resource_type: string;
  format?: string;
  bytes: number;
  etag?: string;
};

type CloudinaryResourceResult = {
  public_id: string;
  resource_type?: string;
  format?: string;
  bytes?: number;
  etag?: string;
};

export interface CloudinaryClientPort {
  uploadStream(
    options: Record<string, unknown>,
    callback: (error?: unknown, result?: CloudinaryUploadResult) => void,
  ): Writable;
  resource(publicId: string, options: Record<string, unknown>): Promise<CloudinaryResourceResult>;
  destroy(publicId: string, options: Record<string, unknown>): Promise<{ result?: string }>;
  privateDownloadUrl(publicId: string, format: string, options: Record<string, unknown>): string;
}

export type CloudinaryStorageFailureCode =
  | 'CONFIGURATION'
  | 'AUTHENTICATION'
  | 'PERMISSION'
  | 'RATE_LIMIT'
  | 'TRANSIENT'
  | 'NOT_FOUND'
  | 'VALIDATION';

export class CloudinaryStorageError extends Error {
  constructor(
    readonly code: CloudinaryStorageFailureCode,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'CloudinaryStorageError';
  }
}

function cloudinaryStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const candidate = error as {
    http_code?: unknown;
    statusCode?: unknown;
    error?: { http_code?: unknown; statusCode?: unknown };
  };
  const value =
    candidate.http_code ??
    candidate.statusCode ??
    candidate.error?.http_code ??
    candidate.error?.statusCode;
  return typeof value === 'number' ? value : undefined;
}

function classifyCloudinaryError(error: unknown): CloudinaryStorageError {
  if (error instanceof CloudinaryStorageError) return error;
  const status = cloudinaryStatus(error);
  if (status === 401)
    return new CloudinaryStorageError('AUTHENTICATION', 'Cloudinary authentication failed', false);
  if (status === 403)
    return new CloudinaryStorageError('PERMISSION', 'Cloudinary permission denied', false);
  if (status === 404)
    return new CloudinaryStorageError('NOT_FOUND', 'Cloudinary object was not found', false);
  if (status === 429)
    return new CloudinaryStorageError('RATE_LIMIT', 'Cloudinary rate limit reached', true);
  if (status !== undefined && status >= 500)
    return new CloudinaryStorageError('TRANSIENT', 'Cloudinary service is unavailable', true);
  return new CloudinaryStorageError('TRANSIENT', 'Cloudinary request failed', true);
}

function cloudinaryRejection(error: unknown): Error {
  if (error instanceof Error) return error;
  const wrapped = new Error('Cloudinary request failed');
  const status = cloudinaryStatus(error);
  if (status !== undefined) Object.assign(wrapped, { http_code: status });
  return wrapped;
}

function cloudinaryObject(key: string): {
  publicId: string;
  format: string;
  resourceType: CloudinaryResourceType;
} {
  const normalized = key.replaceAll('\\', '/').replace(/^\/+/, '');
  const match = /\.([a-zA-Z0-9]+)$/.exec(normalized);
  if (!normalized || !match)
    throw new CloudinaryStorageError(
      'VALIDATION',
      'Cloudinary media key must include a file extension',
      false,
    );
  const format = match[1]!.toLowerCase();
  return {
    publicId: normalized.slice(0, -match[0].length),
    format,
    resourceType: ['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(format) ? 'image' : 'video',
  };
}

function createCloudinaryClient(config: CloudinaryMediaStorageConfig): CloudinaryClientPort {
  cloudinary.config({
    cloud_name: config.cloudName,
    api_key: config.apiKey,
    api_secret: config.apiSecret,
    secure: true,
  });
  return {
    uploadStream: (options, callback) =>
      cloudinary.uploader.upload_stream(options, (error, result) => callback(error, result)),
    resource: (publicId, options) =>
      cloudinary.api.resource(publicId, options) as Promise<CloudinaryResourceResult>,
    destroy: (publicId, options) =>
      cloudinary.uploader.destroy(publicId, options) as Promise<{ result?: string }>,
    privateDownloadUrl: (publicId, format, options) =>
      cloudinary.utils.private_download_url(publicId, format, options),
  };
}

export class CloudinaryMediaStorage implements MediaStorage {
  readonly provider = 'cloudinary';
  readonly bucket: string;
  private readonly client: CloudinaryClientPort;

  constructor(config: CloudinaryMediaStorageConfig, client?: CloudinaryClientPort) {
    if (!config.cloudName || !config.apiKey || !config.apiSecret)
      throw new CloudinaryStorageError(
        'CONFIGURATION',
        'Cloudinary cloud name, API key and API secret are required',
        false,
      );
    this.bucket = config.cloudName;
    this.client = client ?? createCloudinaryClient(config);
  }

  async upload(input: MediaUploadInput): Promise<MediaObjectMetadata> {
    if (!input.key.trim() || !input.contentType.trim())
      throw new CloudinaryStorageError('VALIDATION', 'key and contentType are required', false);
    const object = cloudinaryObject(input.key);
    const resourceType: CloudinaryResourceType = input.contentType.startsWith('image/')
      ? 'image'
      : input.contentType.startsWith('video/')
        ? 'video'
        : (() => {
            throw new CloudinaryStorageError(
              'VALIDATION',
              'Cloudinary media must be an image or video',
              false,
            );
          })();
    try {
      const result = await new Promise<CloudinaryUploadResult>((resolve, reject) => {
        const target = this.client.uploadStream(
          {
            public_id: object.publicId,
            resource_type: resourceType,
            type: 'private',
            overwrite: true,
            unique_filename: false,
            use_filename: false,
            invalidate: true,
          },
          (error, response) => {
            if (error) reject(cloudinaryRejection(error));
            else if (!response) reject(new Error('Cloudinary upload returned no result'));
            else resolve(response);
          },
        );
        target.once('error', reject);
        const source = input.body instanceof Uint8Array ? Readable.from([input.body]) : input.body;
        source.once('error', reject);
        source.pipe(target);
      });
      return {
        key: input.key,
        contentType: input.contentType,
        sizeBytes: result.bytes,
        ...(result.etag || input.checksum ? { checksum: result.etag ?? input.checksum } : {}),
      };
    } catch (error) {
      throw classifyCloudinaryError(error);
    }
  }

  async head(key: string): Promise<MediaObjectMetadata | null> {
    const object = cloudinaryObject(key);
    try {
      const result = await this.client.resource(object.publicId, {
        resource_type: object.resourceType,
        type: 'private',
      });
      return {
        key,
        contentType: `${object.resourceType}/${result.format ?? object.format}`,
        sizeBytes: result.bytes ?? 0,
        ...(result.etag ? { checksum: result.etag } : {}),
      };
    } catch (error) {
      const classified = classifyCloudinaryError(error);
      if (classified.code === 'NOT_FOUND') return null;
      throw classified;
    }
  }

  createReadUrl(key: string, ttlSeconds: number): Promise<TemporaryReadUrl> {
    const object = cloudinaryObject(key);
    if (ttlSeconds <= 0)
      throw new CloudinaryStorageError('VALIDATION', 'URL lifetime must be positive', false);
    const expiresAt = new Date(Date.now() + ttlSeconds * 1_000);
    try {
      const url = this.client.privateDownloadUrl(object.publicId, object.format, {
        resource_type: object.resourceType,
        type: 'private',
        expires_at: Math.floor(expiresAt.getTime() / 1_000),
      });
      return Promise.resolve({ url, expiresAt });
    } catch (error) {
      return Promise.reject(classifyCloudinaryError(error));
    }
  }

  async delete(key: string): Promise<void> {
    const object = cloudinaryObject(key);
    try {
      await this.client.destroy(object.publicId, {
        resource_type: object.resourceType,
        type: 'private',
        invalidate: true,
      });
    } catch (error) {
      const classified = classifyCloudinaryError(error);
      if (classified.code !== 'NOT_FOUND') throw classified;
    }
  }
}

export interface R2MediaStorageConfig {
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  region?: string;
}

export class R2MediaStorage implements MediaStorage {
  readonly provider = 'r2';
  readonly bucket: string;
  private readonly client: S3Client;
  constructor(config: R2MediaStorageConfig) {
    if (!config.endpoint || !config.accessKeyId || !config.secretAccessKey || !config.bucket)
      throw new Error('R2 endpoint, credentials and bucket are required');
    this.bucket = config.bucket;
    this.client = new S3Client({
      region: config.region ?? 'auto',
      endpoint: config.endpoint,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    });
  }
  async upload(input: MediaUploadInput): Promise<MediaObjectMetadata> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: input.key,
        Body: input.body,
        ContentType: input.contentType,
        ...(input.contentLength !== undefined ? { ContentLength: input.contentLength } : {}),
        ...(input.checksum ? { Metadata: { sha256: input.checksum } } : {}),
      }),
    );
    const metadata = await this.head(input.key);
    if (!metadata) throw new Error('R2 upload completed but object metadata is unavailable');
    return metadata;
  }
  async head(key: string): Promise<MediaObjectMetadata | null> {
    try {
      const result = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return {
        key,
        contentType: result.ContentType ?? 'application/octet-stream',
        sizeBytes: result.ContentLength ?? 0,
        ...(result.Metadata?.['sha256'] ? { checksum: result.Metadata['sha256'] } : {}),
      };
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata
        ?.httpStatusCode;
      if (status === 404) return null;
      throw error;
    }
  }
  async createReadUrl(key: string, ttlSeconds: number): Promise<TemporaryReadUrl> {
    const expiresAt = new Date(Date.now() + ttlSeconds * 1_000);
    const url = await getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { expiresIn: ttlSeconds },
    );
    return { url, expiresAt };
  }
  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}
