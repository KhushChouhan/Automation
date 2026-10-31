export const QUEUE_NAMES = {
  syncGoogle: 'sync-google',
  syncGoogleDrive: 'sync-google-drive',
  syncGoogleSheet: 'sync-google-sheet',
  mirrorGoogleSheet: 'mirror-google-sheet',
  validateUpdatedVideos: 'validate-updated-videos',
  validateVideo: 'validate-video',
  selectDailyReels: 'select-daily-reels',
  generateContent: 'generate-content',
  prepareMedia: 'prepare-media',
  publishInstagram: 'publish-instagram',
  reconcilePublish: 'reconcile-publish',
  cleanupMedia: 'cleanup-media',
  mirrorSheet: 'mirror-sheet',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

function safeJobPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/** BullMQ job IDs must not contain ':'. This stable format preserves the blueprint key's components. */
export function publishJobId(videoId: string, scheduledAtUtc: string | Date): string {
  const instant =
    scheduledAtUtc instanceof Date
      ? scheduledAtUtc.toISOString()
      : new Date(scheduledAtUtc).toISOString();
  return `publish-${safeJobPart(videoId)}-${instant.replace(/[^0-9TZ]/g, '')}`;
}

export interface QueueJobPayload {
  queueName: QueueName;
  payload: Record<string, unknown>;
  /** Canonical idempotency key persisted on the outbox event. */
  eventKey: string;
  eventType?: string;
  options?: { delay?: number; attempts?: number; backoff?: { type: 'exponential'; delay: number } };
}

export interface QueuePublisher {
  add(
    name: string,
    data: Record<string, unknown>,
    options: {
      jobId: string;
      delay?: number;
      attempts?: number;
      backoff?: { type: 'exponential'; delay: number };
    },
  ): Promise<unknown>;
}

export function queueJobId(
  job: Pick<QueueJobPayload, 'queueName' | 'eventKey' | 'payload'>,
): string {
  if (
    job.queueName === QUEUE_NAMES.publishInstagram &&
    typeof job.payload['videoId'] === 'string'
  ) {
    const scheduledAt = job.payload['scheduledAtUtc'];
    if (typeof scheduledAt === 'string' || scheduledAt instanceof Date) {
      return publishJobId(job.payload['videoId'], scheduledAt);
    }
  }
  return safeJobPart(job.eventKey).replace(/^-+|-+$/g, '');
}

export async function enqueueOutboxJob(queue: QueuePublisher, job: QueueJobPayload): Promise<void> {
  await queue.add(job.queueName, job.payload, { jobId: queueJobId(job), ...job.options });
}

export type OutboxRecord = QueueJobPayload & { id: string };

/** Narrow DB port: implementations claim rows transactionally and persist delivery state. */
export interface OutboxRepository {
  claimPending(limit: number): Promise<OutboxRecord[]>;
  markDelivered(id: string, deliveredAt: Date): Promise<void>;
  markFailed(id: string, error: string): Promise<void>;
}

export interface OutboxDispatcherOptions {
  repository: OutboxRepository;
  queues: Partial<Record<QueueName, QueuePublisher>>;
  batchSize?: number;
  now?: () => Date;
}

export async function dispatchOutboxBatch(
  options: OutboxDispatcherOptions,
): Promise<{ delivered: number; failed: number }> {
  const records = await options.repository.claimPending(options.batchSize ?? 50);
  let delivered = 0;
  let failed = 0;
  for (const record of records) {
    try {
      const queue = options.queues[record.queueName];
      if (!queue) throw new Error(`No queue configured for ${record.queueName}`);
      await enqueueOutboxJob(queue, record);
      await options.repository.markDelivered(record.id, (options.now ?? (() => new Date()))());
      delivered += 1;
    } catch (error) {
      await options.repository.markFailed(
        record.id,
        error instanceof Error ? error.message : String(error),
      );
      failed += 1;
    }
  }
  return { delivered, failed };
}
