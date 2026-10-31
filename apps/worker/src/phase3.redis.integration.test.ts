import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';

const redisUrl = process.env['REDIS_URL'];
const queueName = `phase3-recovery-${randomUUID()}`;
let connection: Redis | undefined;
let queue: Queue | undefined;

beforeAll(() => {
  if (!redisUrl) return;
  connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
  queue = new Queue(queueName, { connection });
});

afterAll(async () => {
  if (!queue || !connection) return;
  await queue.removeJobScheduler('phase3-test-scheduler').catch(() => undefined);
  await queue.obliterate({ force: true }).catch(() => undefined);
  await queue.close();
  await connection.quit();
}, 30_000);

describe.skipIf(!redisUrl)('Phase 3 Redis durability', () => {
  it('deduplicates delayed dispatch and preserves it across a queue restart', async () => {
    const currentQueue = queue!;
    const jobId = 'publish-GCS-0021-20261115T133000000Z';
    await currentQueue.add(
      'publish-instagram',
      { scheduleId: 'test-schedule' },
      {
        jobId,
        delay: 60_000,
      },
    );
    await currentQueue.add(
      'publish-instagram',
      { scheduleId: 'test-schedule' },
      {
        jobId,
        delay: 60_000,
      },
    );
    expect(await currentQueue.getJobCounts('delayed')).toMatchObject({ delayed: 1 });

    await currentQueue.close();
    connection!.disconnect();
    connection = new Redis(redisUrl!, { maxRetriesPerRequest: null });
    queue = new Queue(queueName, { connection });
    const recovered = await queue.getJob(jobId);
    expect(recovered?.id).toBe(jobId);
    expect(await recovered?.getState()).toBe('delayed');
  }, 30_000);

  it('uses BullMQ Job Schedulers without deprecated repeat registration', async () => {
    const currentQueue = queue!;
    await currentQueue.upsertJobScheduler(
      'phase3-test-scheduler',
      { pattern: '0 6 * * *', tz: 'Asia/Kolkata' },
      { name: 'daily-selection', data: { source: 'test' } },
    );
    const schedulers = await currentQueue.getJobSchedulers(0, 10, true);
    expect(schedulers.some((scheduler) => scheduler.key === 'phase3-test-scheduler')).toBe(true);
  }, 30_000);
});
