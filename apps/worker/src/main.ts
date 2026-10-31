import { Redis } from 'ioredis';
import { loadConfig } from '@gcs/config';
import { createDatabaseClient, selectReadyBacklog } from '@gcs/database';
import { businessDateOf } from '@gcs/core';
import { GoogleDriveV3Adapter, GoogleSheetsV4Adapter } from '@gcs/integrations';
import { createLogger } from '@gcs/observability';
import { Queue, type Job, type Processor } from 'bullmq';
import { runGoogleSync } from './google-sync.js';
import { dispatchOutboxBatch, QUEUE_NAMES, type QueueName } from './queues.js';
import { startWorkerRuntime, stopWorkerRuntime } from './runtime.js';
import { PrismaOutboxRepository } from './outbox.js';
import {
  createCleanupProcessor,
  createContentProcessor,
  createMediaPreparationProcessor,
  type ContentProcessorResult,
  type MediaProcessorResult,
} from './phase3.js';
import { createInstagramPublishProcessors } from './instagram-publish.js';

const config = loadConfig();
const logger = createLogger({ level: config.logLevel });
const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
redis.on('error', (err) => {
  logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Redis connection warning');
});
const db = createDatabaseClient();
const queues = Object.fromEntries(
  Object.values(QUEUE_NAMES).map((name) => {
    const queue = new Queue(name, { connection: redis });
    queue.on('error', (err) => {
      logger.warn({ queue: name, err: err instanceof Error ? err.message : String(err) }, 'Queue connection warning');
    });
    return [name, queue];
  }),
) as Record<QueueName, Queue>;
const syncQueue = queues[QUEUE_NAMES.syncGoogle];
const googleReady =
  config.google.credentialsConfigured &&
  Boolean(config.google.sheetId && config.google.videoFolderId && config.google.thumbnailFolderId);
const drive = googleReady ? new GoogleDriveV3Adapter() : null;
const sheet = googleReady ? new GoogleSheetsV4Adapter() : null;
const contentProcessor = createContentProcessor(db, config);
const mediaProcessor = createMediaPreparationProcessor(db, config);
const cleanupProcessor = createCleanupProcessor(db, config);
const instagramPublishProcessors = createInstagramPublishProcessors(db, config);
const jobString = (value: unknown, fallback = ''): string =>
  typeof value === 'string' && value.trim() ? value : fallback;
const workers = startWorkerRuntime({
  connection: redis,
  logger,
  processors: {
    [QUEUE_NAMES.syncGoogle]: async () => {
      if (
        !drive ||
        !sheet ||
        !config.google.sheetId ||
        !config.google.videoFolderId ||
        !config.google.thumbnailFolderId
      )
        return { skipped: true, reason: 'Google integration is not configured' };
      return runGoogleSync(db, drive, sheet, {
        spreadsheetId: config.google.sheetId,
        videoFolderId: config.google.videoFolderId,
        thumbnailFolderId: config.google.thumbnailFolderId,
      });
    },
    [QUEUE_NAMES.selectDailyReels]: async (job) => {
      const manual = job.data['manual'] === true;
      if (!config.automationEnabled && !manual)
        return { skipped: true, reason: 'Automation is OFF' };
      const target =
        typeof job.data['businessDate'] === 'string'
          ? job.data['businessDate']
          : businessDateOf(new Date());
      const schedules = await selectReadyBacklog(db, {
        startBusinessDate: target,
        horizonDays: config.orchestration.schedulingHorizonDays,
        actorId: manual ? 'manual-selection' : 'selection-scheduler',
        gapDays: config.faceGapDays,
      });
      return {
        startBusinessDate: target,
        horizonDays: config.orchestration.schedulingHorizonDays,
        schedules: schedules.length,
      };
    },
    [QUEUE_NAMES.generateContent]: async (job) => {
      const result = await contentProcessor(
        job as unknown as Job<Record<string, unknown>, ContentProcessorResult>,
      );
      if (googleReady)
        await syncQueue.add(
          'mirror-after-content',
          { source: 'content-worker' },
          {
            jobId: `mirror-content-${jobString(job.data['videoId'], job.id ?? 'unknown')}`,
            removeOnComplete: 100,
            removeOnFail: 100,
          },
        );
      return result;
    },
    [QUEUE_NAMES.prepareMedia]: (job) =>
      mediaProcessor(job as unknown as Job<Record<string, unknown>, MediaProcessorResult>),
    [QUEUE_NAMES.cleanupMedia]: (job) =>
      cleanupProcessor(job as unknown as Job<Record<string, unknown>, { cleaned: true }>),
    [QUEUE_NAMES.publishInstagram]: instagramPublishProcessors.publish as Processor<
      Record<string, unknown>,
      unknown
    >,
    [QUEUE_NAMES.reconcilePublish]: instagramPublishProcessors.reconcile as Processor<
      Record<string, unknown>,
      unknown
    >,
  },
});

if (googleReady) {
  await syncQueue.upsertJobScheduler(
    'google-sync-recurring',
    { every: config.google.syncIntervalMinutes * 60_000 },
    { name: 'recurring-sync', data: { source: 'scheduler' } },
  );
}

const [selectionHour, selectionMinute] = config.orchestration.dailySelectionTime
  .split(':')
  .map(Number) as [number, number];
await queues[QUEUE_NAMES.selectDailyReels].upsertJobScheduler(
  'daily-selection-ist',
  { pattern: `${selectionMinute} ${selectionHour} * * *`, tz: config.timezone },
  { name: 'daily-selection', data: { source: 'scheduler' } },
);

const outboxRepository = new PrismaOutboxRepository(db);
const dispatchOutbox = async () => {
  const result = await dispatchOutboxBatch({ repository: outboxRepository, queues });
  if (result.delivered || result.failed) logger.info(result, 'outbox dispatch completed');
};
await dispatchOutbox();
const outboxTimer = setInterval(() => void dispatchOutbox(), 2_000);
outboxTimer.unref();

const shutdown = async (signal: string) => {
  logger.info({ signal }, 'shutting down worker runtime');
  clearInterval(outboxTimer);
  await stopWorkerRuntime(workers);
  await Promise.allSettled([
    ...Object.values(queues).map((queue) => queue.close()),
    db.$disconnect(),
  ]);
  await redis.quit();
  process.exit(0);
};

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

logger.info(
  {
    queues: workers.length,
    automationEnabled: config.automationEnabled,
    googleConfigured: googleReady,
    googleSyncIntervalMinutes: config.google.syncIntervalMinutes,
    contentGeneratorProvider: config.content.provider,
    contentGeneratorConfigured: config.content.configured,
    mediaProvider: config.media.provider,
    dailySelectionTime: config.orchestration.dailySelectionTime,
    schedulingHorizonDays: config.orchestration.schedulingHorizonDays,
    metaPublishingEnabled: config.meta.publishingEnabled,
  },
  'worker runtime started; Instagram publishing is disabled',
);
