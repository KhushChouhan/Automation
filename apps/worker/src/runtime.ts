import { Worker, type ConnectionOptions, type Job, type Processor } from 'bullmq';
import type { AppLogger } from '@gcs/observability';
import { QUEUE_NAMES, type QueueName } from './queues.js';

export interface WorkerRuntimeOptions {
  connection: ConnectionOptions;
  logger: AppLogger;
  /** Injectable processors for later domain slices; publish remains guarded by default. */
  processors?: Partial<Record<QueueName, Processor<Record<string, unknown>, unknown>>>;
}

const noOpProcessor: Processor<Record<string, unknown>, unknown> = (
  job: Job<Record<string, unknown>>,
) => Promise.resolve({ skipped: true, reason: `No processor configured for ${job.queueName}` });

const safePublishProcessor: Processor<Record<string, unknown>, unknown> = (
  job: Job<Record<string, unknown>>,
) =>
  Promise.resolve({
    skipped: true,
    reason: 'Publishing is not implemented in this milestone',
    jobId: job.id,
  });

export function startWorkerRuntime(options: WorkerRuntimeOptions): Worker[] {
  return Object.values(QUEUE_NAMES).map((queueName) => {
    const processor =
      queueName === QUEUE_NAMES.publishInstagram
        ? (options.processors?.[queueName] ?? safePublishProcessor)
        : (options.processors?.[queueName] ?? noOpProcessor);
    const worker = new Worker(queueName, processor, { connection: options.connection });
    worker.on('completed', (job, result) =>
      options.logger.info({ queueName, jobId: job.id, result }, 'queue job completed'),
    );
    worker.on('failed', (job, error) =>
      options.logger.error({ queueName, jobId: job?.id, error }, 'queue job failed'),
    );
    worker.on('error', (error) => options.logger.error({ queueName, error }, 'queue worker error'));
    return worker;
  });
}

export async function stopWorkerRuntime(workers: Worker[]): Promise<void> {
  await Promise.all(workers.map((worker) => worker.close()));
}
