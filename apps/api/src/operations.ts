import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@gcs/database';
import { decideApproval, setAutomationSetting } from '@gcs/database';

type VideoWhere = NonNullable<Parameters<PrismaClient['video']['count']>[0]>['where'];
type SelectionQueue = {
  add(
    name: string,
    data: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): Promise<{ id?: string }>;
};
const filters: Record<string, VideoWhere> = {
  all: {},
  waiting: {
    workflowStatus: {
      in: [
        'WAITING_VIDEO',
        'WAITING_FACE',
        'WAITING_TITLE',
        'WAITING_THUMBNAIL',
        'WAITING_APPROVAL',
      ],
    },
  },
  ready: { workflowStatus: 'READY' },
  scheduled: {
    workflowStatus: {
      in: ['SELECTED', 'CONTENT_GENERATING', 'CONTENT_READY', 'SCHEDULED', 'PUBLISHING'],
    },
  },
  failed: { workflowStatus: { in: ['FAILED', 'RECONCILE_REQUIRED'] } },
  manualAction: { manualActionRequired: true },
  approvals: { workflowStatus: 'WAITING_APPROVAL' },
};
function driveUrl(id: string | null | undefined, preview = false): string | null {
  return id && /^[a-zA-Z0-9_-]{1,200}$/.test(id)
    ? `https://drive.google.com/file/d/${id}/${preview ? 'preview' : 'view'}`
    : null;
}
function safeCode(value: string | null | undefined): string | null {
  return value ? (/^[A-Z0-9_:-]{1,100}$/.test(value) ? value : 'PROVIDER_ERROR') : null;
}

export function registerOperations(
  app: FastifyInstance,
  db: PrismaClient,
  selectionQueue?: SelectionQueue,
) {
  for (const [path, fixedFilter] of [
    ['videos', null],
    ['approvals', 'approvals'],
    ['failures', 'failed'],
  ] as const) {
    app.get(`/api/v1/${path}`, async (request, reply) => {
      const query = request.query as Record<string, unknown>;
      const filter = fixedFilter ?? (typeof query['filter'] === 'string' ? query['filter'] : 'all');
      const q = typeof query['q'] === 'string' ? query['q'].trim() : '';
      const offset = query['offset'] === undefined ? 0 : Number(query['offset']);
      if (
        !Object.hasOwn(filters, filter) ||
        q.length > 100 ||
        !Number.isInteger(offset) ||
        offset < 0 ||
        offset > 100_000
      )
        return reply.code(400).send({ error: 'Invalid list filter or offset' });
      const where: VideoWhere = {
        AND: [
          filters[filter] ?? {},
          ...(q
            ? [
                {
                  OR: [
                    { videoId: { contains: q, mode: 'insensitive' as const } },
                    { title: { contains: q, mode: 'insensitive' as const } },
                    { face: { name: { contains: q, mode: 'insensitive' as const } } },
                  ],
                },
              ]
            : []),
        ],
      };
      const [total, videos] = await Promise.all([
        db.video.count({ where }),
        db.video.findMany({
          where,
          orderBy: [{ updatedAt: 'desc' }, { videoId: 'asc' }],
          skip: offset,
          take: 50,
          select: {
            videoId: true,
            title: true,
            inputVersion: true,
            driveFileId: true,
            approvalStatus: true,
            workflowStatus: true,
            updatedAt: true,
            manualActionRequired: true,
            manualActionReason: true,
            face: { select: { name: true } },
            thumbnail: { select: { driveFileId: true, mimeType: true } },
            approvals: {
              orderBy: { createdAt: 'desc' },
              take: 10,
              select: { id: true, decision: true, actorId: true, reason: true, createdAt: true },
            },
            content: {
              orderBy: { version: 'desc' },
              take: 1,
              select: {
                version: true,
                caption: true,
                hashtags: true,
                cta: true,
                provider: true,
                modelName: true,
                promptVersion: true,
                regenerated: true,
                createdAt: true,
              },
            },
            postingHistory: {
              select: { instagramMediaId: true, permalink: true, postedAt: true },
            },
            schedule: {
              select: {
                businessDate: true,
                slotHour: true,
                status: true,
                scheduledAt: true,
                mediaAsset: { select: { status: true, lastError: true } },
              },
            },
            publishAttempts: {
              orderBy: { createdAt: 'desc' },
              take: 1,
              select: {
                id: true,
                status: true,
                errorCode: true,
                failureClass: true,
                reconcileRequiredAt: true,
              },
            },
          },
        }),
      ]);
      return {
        filter,
        q,
        total,
        offset,
        limit: 50,
        videos: videos.map(
          ({ driveFileId, thumbnail, schedule, publishAttempts, content, ...video }) => ({
            ...video,
            previewUrl: driveUrl(driveFileId, true),
            sourceUrl: driveUrl(driveFileId),
            thumbnailUrl: driveUrl(thumbnail?.driveFileId, true),
            thumbnailSourceUrl: driveUrl(thumbnail?.driveFileId),
            schedule: schedule
              ? {
                  ...schedule,
                  mediaAsset: schedule.mediaAsset
                    ? {
                        status: schedule.mediaAsset.status,
                        errorCode: safeCode(schedule.mediaAsset.lastError),
                      }
                    : null,
                }
              : null,
            latestAttempt: publishAttempts[0]
              ? { ...publishAttempts[0], errorCode: safeCode(publishAttempts[0].errorCode) }
              : null,
            generatedContent: content[0] ?? null,
          }),
        ),
      };
    });
  }
  app.get('/api/v1/schedule', async () => ({
    timezone: 'Asia/Kolkata',
    schedules: await db.schedule.findMany({
      orderBy: { scheduledAt: 'desc' },
      take: 100,
      select: {
        id: true,
        businessDate: true,
        slotHour: true,
        scheduledAt: true,
        status: true,
        video: {
          select: { videoId: true, title: true, approvalStatus: true, workflowStatus: true },
        },
        face: { select: { name: true } },
        mediaAsset: { select: { status: true } },
      },
    }),
  }));
  app.get('/api/v1/audit-events', async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const offset = query['offset'] === undefined ? 0 : Number(query['offset']);
    if (!Number.isInteger(offset) || offset < 0 || offset > 100_000)
      return reply.code(400).send({ error: 'Invalid offset' });
    const [total, events] = await Promise.all([
      db.auditLog.count(),
      db.auditLog.findMany({
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: offset,
        take: 50,
        select: {
          id: true,
          actorId: true,
          action: true,
          entity: true,
          entityId: true,
          createdAt: true,
        },
      }),
    ]);
    return { total, offset, limit: 50, events };
  });
  app.get('/api/v1/settings', async () => {
    const setting = await db.automationSetting.findUnique({
      where: { key: 'automation.enabled' },
      select: { value: true, version: true, updatedAt: true },
    });
    return {
      schedulingAutomationEnabled: setting?.value === true,
      instagramWriteEnabled: false,
      timezone: 'Asia/Kolkata',
      slots: ['19:00', '20:00'],
      dailyLimit: 2,
      source: setting ? 'database' : 'default_off',
      version: setting?.version ?? 0,
      updatedAt: setting?.updatedAt ?? null,
      publishingBlockReason: 'CONTROLLED_STAGING_APPROVAL_REQUIRED',
      readOnly: false,
    };
  });
  app.patch('/api/v1/settings/scheduling', async (request, reply) => {
    const body = request.body as Record<string, unknown> | null;
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      typeof body['enabled'] !== 'boolean' ||
      !Number.isInteger(body['expectedVersion']) ||
      Number(body['expectedVersion']) < 0 ||
      (body['enabled'] === true && body['confirmation'] !== 'ENABLE SCHEDULING')
    )
      return reply.code(400).send({ error: 'Invalid scheduling setting command' });
    try {
      const setting = await setAutomationSetting(db, {
        key: 'automation.enabled',
        value: body['enabled'],
        expectedVersion: Number(body['expectedVersion']),
        actorId: 'admin-dashboard',
      });
      let selectionQueued = false;
      if (body['enabled'] === true && selectionQueue) {
        try {
          await selectionQueue.add(
            'settings-enabled',
            { source: 'admin-settings', manual: false },
            {
              jobId: `settings-selection-v${setting.version}`,
              removeOnComplete: 100,
              removeOnFail: 100,
            },
          );
          selectionQueued = true;
        } catch {
          // PostgreSQL remains authoritative. The recurring worker scheduler
          // will retry backlog selection when immediate delivery is unavailable.
        }
      }
      return {
        schedulingAutomationEnabled: setting.value === true,
        selectionQueued,
        version: setting.version,
        instagramWriteEnabled: false,
      };
    } catch {
      return reply.code(409).send({ error: 'Setting changed; refresh before trying again' });
    }
  });
  app.post('/api/v1/videos/:id/approval', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as Record<string, unknown> | null;
    if (
      !/^GCS-[0-9]{4,}$/.test(id) ||
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      !['APPROVED', 'REJECTED', 'CHANGES_REQUIRED'].includes(String(body['decision'])) ||
      !Number.isInteger(body['expectedInputVersion']) ||
      Number(body['expectedInputVersion']) < 0 ||
      typeof body['reason'] !== 'string' ||
      body['reason'].trim().length > 1000 ||
      (body['decision'] !== 'APPROVED' && !body['reason'].trim())
    )
      return reply.code(400).send({
        error:
          'Decision, reviewed input version and reason (for rejection or changes) are required',
      });
    try {
      const result = await decideApproval(db, id, {
        decision: body['decision'] as 'APPROVED' | 'REJECTED' | 'CHANGES_REQUIRED',
        ...(body['reason'].trim() ? { reason: body['reason'].trim() } : {}),
        actorId: 'admin-dashboard',
        expectedInputVersion: Number(body['expectedInputVersion']),
      });
      return {
        success: true,
        videoId: result.video.videoId,
        approvalStatus: result.video.approvalStatus,
        workflowStatus: result.video.workflowStatus,
      };
    } catch (error) {
      const stale = error instanceof Error && error.message === 'STALE_INPUT';
      return reply.code(409).send({
        error: stale
          ? 'Video changed since review. Refresh and review again.'
          : 'Decision rejected; refresh and verify video state',
      });
    }
  });
}
