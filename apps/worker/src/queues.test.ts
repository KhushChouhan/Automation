import { describe, expect, it } from 'vitest';
import {
  dispatchOutboxBatch,
  publishJobId,
  queueJobId,
  QUEUE_NAMES,
  type OutboxRepository,
  type QueuePublisher,
} from './queues.js';

describe('queue foundation', () => {
  it('creates stable BullMQ-safe publish IDs from the business key', () => {
    const first = publishJobId('GCS-0001', '2026-10-27T13:30:00.000Z');
    expect(first).toBe(publishJobId('GCS-0001', new Date('2026-10-27T13:30:00.000Z')));
    expect(first).toBe('publish-GCS-0001-20261027T133000000Z');
    expect(first).not.toContain(':');
  });

  it('dispatches queue records with deterministic IDs and persists outcomes', async () => {
    const delivered: string[] = [];
    const failures: string[] = [];
    const records = [
      {
        id: 'outbox-1',
        queueName: QUEUE_NAMES.publishInstagram,
        eventType: 'selection.created',
        eventKey: 'publish:GCS-0001:2026-10-27T13:30:00.000Z',
        payload: {
          scheduleId: 's1',
          videoId: 'GCS-0001',
          scheduledAtUtc: '2026-10-27T13:30:00.000Z',
          businessDate: '2026-10-27',
          slotHour: 19,
        },
      },
    ];
    const repository: OutboxRepository = {
      claimPending() {
        return Promise.resolve(records);
      },
      markDelivered(id) {
        delivered.push(id);
        return Promise.resolve();
      },
      markFailed(id) {
        failures.push(id);
        return Promise.resolve();
      },
    };
    let enqueued: string | undefined;
    const queue: QueuePublisher = {
      add(_name, _payload, options) {
        enqueued = options.jobId;
        return Promise.resolve();
      },
    };
    const result = await dispatchOutboxBatch({
      repository,
      queues: { [QUEUE_NAMES.publishInstagram]: queue },
    });
    expect(result).toEqual({ delivered: 1, failed: 0 });
    expect(enqueued).toBe('publish-GCS-0001-20261027T133000000Z');
    expect(delivered).toEqual(['outbox-1']);
    expect(failures).toEqual([]);
  });

  it('normalizes the canonical publish event key for BullMQ', () => {
    expect(
      queueJobId({
        queueName: QUEUE_NAMES.publishInstagram,
        eventKey: 'publish:GCS-0001:2026-10-27T13:30:00.000Z',
        payload: { videoId: 'GCS-0001', scheduledAtUtc: '2026-10-27T13:30:00.000Z' },
      }),
    ).toBe('publish-GCS-0001-20261027T133000000Z');
  });
});
