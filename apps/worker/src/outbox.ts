import type { Prisma, PrismaClient } from '@gcs/database';
import { QUEUE_NAMES } from './queues.js';
import type { OutboxRecord, OutboxRepository, QueueName } from './queues.js';

function queueForEvent(eventType: string): QueueName {
  if (eventType === 'selection.created') return QUEUE_NAMES.generateContent;
  if (eventType === 'content.generated') return QUEUE_NAMES.prepareMedia;
  if (eventType === 'media.prepared') return QUEUE_NAMES.publishInstagram;
  if (eventType === 'publish.resume') return QUEUE_NAMES.publishInstagram;
  if (eventType === 'publish.reconcile') return QUEUE_NAMES.reconcilePublish;
  // Finalization is authoritative in PostgreSQL.  The existing Google sync
  // worker mirrors those system-owned fields to the coordination Sheet.
  if (eventType === 'sheet.mirror') return QUEUE_NAMES.syncGoogle;
  if (eventType === 'media.cleanup') return QUEUE_NAMES.cleanupMedia;
  throw new Error(`Unsupported outbox event type: ${eventType}`);
}

function recordPayload(value: Prisma.JsonValue): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Outbox payload must be an object');
  return value;
}

export class PrismaOutboxRepository implements OutboxRepository {
  constructor(private readonly db: PrismaClient) {}
  async claimPending(limit: number): Promise<OutboxRecord[]> {
    const rows = await this.db.outboxEvent.findMany({
      where: { status: 'PENDING', availableAt: { lte: new Date() } },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
    if (rows.length)
      await this.db.outboxEvent.updateMany({
        where: { id: { in: rows.map((row) => row.id) }, status: 'PENDING' },
        data: { attempts: { increment: 1 } },
      });
    return rows.map((row) => {
      const payload = recordPayload(row.payload);
      const scheduledAt =
        row.eventType === 'media.prepared' && typeof payload['scheduledAtUtc'] === 'string'
          ? new Date(payload['scheduledAtUtc']).getTime()
          : null;
      return {
        id: row.id,
        queueName: queueForEvent(row.eventType),
        eventKey: row.eventKey,
        eventType: row.eventType,
        payload,
        options: {
          attempts: row.eventType === 'selection.created' ? 4 : 3,
          backoff: { type: 'exponential', delay: 1_000 },
          ...(scheduledAt !== null ? { delay: Math.max(0, scheduledAt - Date.now()) } : {}),
        },
      };
    });
  }
  async markDelivered(id: string, deliveredAt: Date): Promise<void> {
    await this.db.outboxEvent.update({
      where: { id },
      data: { status: 'DELIVERED', deliveredAt, lastError: null },
    });
  }
  async markFailed(id: string, error: string): Promise<void> {
    const row = await this.db.outboxEvent.findUniqueOrThrow({ where: { id } });
    await this.db.outboxEvent.update({
      where: { id },
      data: {
        status: row.attempts >= 5 ? 'FAILED' : 'PENDING',
        lastError: error.slice(0, 500),
        availableAt: new Date(Date.now() + Math.min(60_000, 1_000 * 2 ** row.attempts)),
      },
    });
  }
}
