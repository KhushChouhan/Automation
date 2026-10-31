import { Readable } from 'node:stream';
import {
  beginContentGeneration,
  beginMediaPreparation,
  completeContentGeneration,
  completeMediaPreparation,
  failMediaPreparation,
  markContentScheduled,
  markMediaCleaned,
  recordContentGenerationFailure,
  type PrismaClient,
} from '@gcs/database';
import type { AppConfig } from '@gcs/config';
import type { ContentGenerator } from '@gcs/core';
import {
  ContentGenerationError,
  CloudinaryMediaStorage,
  GeminiContentGenerator,
  GeminiGenerationError,
  createGoogleDriveClientFromEnv,
  LocalMediaStorage,
  OpenAIContentGenerator,
  OpenAIResponsesPort,
  R2MediaStorage,
  type MediaStorage,
} from '@gcs/integrations';
import { UnrecoverableError, type Job, type Processor } from 'bullmq';

type Phase3JobData = Record<string, unknown>;
export type ContentProcessorResult = {
  reused: boolean;
  contentVersion: number;
  model?: string;
};
export type MediaProcessorResult = {
  reused: boolean;
  status: 'READY';
  objectKey?: string;
  expiresAt?: Date;
};

function stringJobField(data: Phase3JobData, key: string, fallback = ''): string {
  const value = data[key];
  return typeof value === 'string' && value.trim() ? value : fallback;
}

function contentGenerator(config: AppConfig): ContentGenerator | null {
  if (!config.content.apiKey) return null;
  if (config.content.provider === 'gemini')
    return new GeminiContentGenerator(config.content.apiKey, {
      timeoutMs: config.content.timeoutMs,
      maxAttempts: config.content.maxAttempts,
    });
  return new OpenAIContentGenerator(
    new OpenAIResponsesPort(config.content.apiKey, config.content.timeoutMs),
    { maxAttempts: config.content.maxAttempts },
  );
}

export function createMediaStorage(config: AppConfig): MediaStorage {
  if (config.media.provider === 'cloudinary') {
    if (!config.media.cloudinaryConfigured)
      throw new Error('Cloudinary storage is selected but not configured');
    return new CloudinaryMediaStorage({
      cloudName: config.media.cloudinary.cloudName!,
      apiKey: config.media.cloudinary.apiKey!,
      apiSecret: config.media.cloudinary.apiSecret!,
    });
  }
  if (config.media.provider === 'r2') {
    if (!config.media.r2Configured) throw new Error('R2 storage is selected but not configured');
    return new R2MediaStorage({
      endpoint:
        config.media.r2.endpoint ?? `https://${config.media.r2.accountId}.r2.cloudflarestorage.com`,
      accessKeyId: config.media.r2.accessKeyId!,
      secretAccessKey: config.media.r2.secretAccessKey!,
      bucket: config.media.r2.bucket!,
    });
  }
  return new LocalMediaStorage(config.media.localDirectory);
}

export function createContentProcessor(
  db: PrismaClient,
  config: AppConfig,
  generator: ContentGenerator | null = contentGenerator(config),
): Processor<Phase3JobData, ContentProcessorResult> {
  return async (job: Job<Phase3JobData>) => {
    const videoId = stringJobField(job.data, 'videoId');
    if (!videoId) throw new UnrecoverableError('videoId is required');
    if (!generator) throw new UnrecoverableError('Content generation is not configured');
    const regenerate = job.data['regenerate'] === true;
    const requestId = regenerate ? stringJobField(job.data, 'requestId', job.id ?? '') : undefined;
    const claim = await beginContentGeneration(db, {
      videoId,
      promptVersion: config.content.promptVersion,
      provider: config.content.provider,
      modelName: config.content.model,
      actorId: stringJobField(job.data, 'actorId', 'content-worker'),
      regenerate,
      ...(requestId ? { regenerationRequestId: requestId } : {}),
    });
    if (claim.reused) return { reused: true, contentVersion: claim.content.version };
    try {
      const result = await generator.generate({
        videoId: claim.video.videoId,
        title: claim.video.title!,
        faceId: claim.video.faceId!,
        approvalStatus: 'APPROVED',
        promptVersion: config.content.promptVersion,
        systemPrompt: config.content.systemPrompt,
        model: config.content.model,
      });
      const saved = await completeContentGeneration(db, {
        videoId,
        generationKey: claim.generationKey,
        promptVersion: config.content.promptVersion,
        provider: config.content.provider,
        modelName: result.model,
        result,
        actorId: stringJobField(job.data, 'actorId', 'content-worker'),
        regenerated: regenerate,
      });
      return { reused: false, contentVersion: saved.version, model: saved.modelName };
    } catch (error) {
      const classified =
        error instanceof ContentGenerationError || error instanceof GeminiGenerationError
          ? error
          : new ContentGenerationError('TRANSIENT', 'Content generation failed', true);
      await recordContentGenerationFailure(db, {
        videoId,
        actorId: 'content-worker',
        errorCode: classified.code,
        retryable: classified.retryable,
        classification: classified.code,
        ...(error instanceof GeminiGenerationError
          ? {
              providerStatus: error.details.status,
              providerType: error.details.providerType,
              providerCode: error.details.providerCode,
              requestId: error.details.requestId,
              retryAfterSeconds: error.details.retryAfterSeconds,
            }
          : {}),
      });
      if (!classified.retryable) throw new UnrecoverableError(classified.message);
      throw classified;
    }
  };
}

export function createMediaPreparationProcessor(
  db: PrismaClient,
  config: AppConfig,
  storage?: MediaStorage,
): Processor<Phase3JobData, MediaProcessorResult> {
  return async (job: Job<Phase3JobData>) => {
    const activeStorage = storage ?? createMediaStorage(config);
    const videoId = stringJobField(job.data, 'videoId');
    if (!videoId) throw new UnrecoverableError('videoId is required');
    await markContentScheduled(db, videoId, 'media-worker');
    let claim = await beginMediaPreparation(db, {
      videoId,
      provider: activeStorage.provider,
      ...(activeStorage.bucket ? { bucket: activeStorage.bucket } : {}),
      actorId: 'media-worker',
    });
    if (claim.reused) {
      const [videoObject, thumbnailObject] = await Promise.all([
        activeStorage.head(claim.keys.video),
        claim.asset.thumbnailObjectKey ? activeStorage.head(claim.asset.thumbnailObjectKey) : null,
      ]);
      if (videoObject && (!claim.asset.thumbnailObjectKey || thumbnailObject))
        return { reused: true, status: 'READY' };
      await db.mediaAsset.update({
        where: { scheduleId: claim.asset.scheduleId },
        data: { status: 'PREPARING', lastError: 'STORAGE_OBJECT_MISSING' },
      });
      claim = await beginMediaPreparation(db, {
        videoId,
        provider: activeStorage.provider,
        ...(activeStorage.bucket ? { bucket: activeStorage.bucket } : {}),
        actorId: 'media-worker-recovery',
      });
    }
    try {
      const drive = createGoogleDriveClientFromEnv();
      const metadata = await drive.files.get({
        fileId: claim.video.driveFileId!,
        fields: 'id,mimeType,size,md5Checksum',
      });
      const mimeType = metadata.data.mimeType ?? '';
      const size = Number(metadata.data.size ?? 0);
      if (!mimeType.startsWith('video/') || !Number.isSafeInteger(size) || size <= 0)
        throw new Error('Drive source video has invalid MIME type or size');
      if (size > 500 * 1024 * 1024) throw new Error('Drive source video exceeds 500 MB limit');
      const downloaded = await drive.files.get(
        { fileId: claim.video.driveFileId!, alt: 'media' },
        { responseType: 'stream' },
      );
      if (!(downloaded.data instanceof Readable))
        throw new Error('Drive did not return a media stream');
      const uploaded = await activeStorage.upload({
        key: claim.keys.video,
        body: downloaded.data,
        contentType: mimeType,
        contentLength: size,
        ...(metadata.data.md5Checksum ? { checksum: metadata.data.md5Checksum } : {}),
      });
      const thumbnailFileId = claim.video.thumbnail?.driveFileId;
      if (thumbnailFileId && claim.asset.thumbnailObjectKey) {
        const thumbnailMetadata = await drive.files.get({
          fileId: thumbnailFileId,
          fields: 'id,mimeType,size,md5Checksum',
        });
        const thumbnailMimeType = thumbnailMetadata.data.mimeType ?? '';
        const thumbnailSize = Number(thumbnailMetadata.data.size ?? 0);
        if (
          !['image/jpeg', 'image/png'].includes(thumbnailMimeType) ||
          !Number.isSafeInteger(thumbnailSize) ||
          thumbnailSize <= 0 ||
          thumbnailSize > 20 * 1024 * 1024
        )
          throw new Error('Drive thumbnail has invalid MIME type or size');
        const thumbnailDownload = await drive.files.get(
          { fileId: thumbnailFileId, alt: 'media' },
          { responseType: 'stream' },
        );
        if (!(thumbnailDownload.data instanceof Readable))
          throw new Error('Drive did not return a thumbnail stream');
        await activeStorage.upload({
          key: claim.asset.thumbnailObjectKey,
          body: thumbnailDownload.data,
          contentType: thumbnailMimeType,
          contentLength: thumbnailSize,
          ...(thumbnailMetadata.data.md5Checksum
            ? { checksum: thumbnailMetadata.data.md5Checksum }
            : {}),
        });
      }
      const url = await activeStorage.createReadUrl(claim.keys.video, config.media.urlTtlSeconds);
      await completeMediaPreparation(db, {
        scheduleId: claim.asset.scheduleId,
        sizeBytes: BigInt(uploaded.sizeBytes),
        ...(uploaded.checksum ? { checksum: uploaded.checksum } : {}),
        expiresAt: url.expiresAt,
        actorId: 'media-worker',
      });
      return { reused: false, status: 'READY', objectKey: uploaded.key, expiresAt: url.expiresAt };
    } catch (error) {
      await failMediaPreparation(db, {
        scheduleId: claim.asset.scheduleId,
        errorCode: error instanceof Error ? error.name : 'UNKNOWN',
        actorId: 'media-worker',
      });
      throw error;
    }
  };
}

export function createCleanupProcessor(
  db: PrismaClient,
  config: AppConfig,
  storage?: MediaStorage,
): Processor<Phase3JobData, { cleaned: true }> {
  return async (job: Job<Phase3JobData>) => {
    const activeStorage = storage ?? createMediaStorage(config);
    const scheduleId = stringJobField(job.data, 'scheduleId');
    const asset = await db.mediaAsset.findUniqueOrThrow({ where: { scheduleId } });
    await activeStorage.delete(asset.videoObjectKey);
    if (asset.thumbnailObjectKey) await activeStorage.delete(asset.thumbnailObjectKey);
    await markMediaCleaned(db, scheduleId, 'cleanup-worker');
    return { cleaned: true };
  };
}
