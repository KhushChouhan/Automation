import { createDatabaseClient, type PrismaClient } from '@gcs/database';
import { loadConfig } from '@gcs/config';
import { getGoogleAuthStatus, MetaGraphInstagramPublisher } from '@gcs/integrations';
import { timingSafeEqual } from 'node:crypto';
import { Queue, type Job } from 'bullmq';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import helmet from '@fastify/helmet';
import { Redis as IORedis, type Redis as RedisClient } from 'ioredis';

export interface GoogleSyncQueue {
  add(
    name: string,
    data: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): Promise<{ id?: string }>;
  getJobCounts(...types: string[]): Promise<Record<string, number>>;
  getJobs(
    types: string[],
    start: number,
    end: number,
    asc?: boolean,
  ): Promise<Array<Pick<Job, 'id' | 'timestamp' | 'finishedOn' | 'processedOn'>>>;
  close(): Promise<void>;
  waitUntilReady?(): Promise<unknown>;
  getJobSchedulers?(
    start?: number,
    end?: number,
    asc?: boolean,
  ): Promise<Array<{ key?: string; name?: string; next?: number; iterationCount?: number }>>;
}

export interface ApiDependencies {
  db?: PrismaClient;
  redis?: RedisClient;
  googleSyncQueue?: GoogleSyncQueue;
  phaseQueues?: Record<string, GoogleSyncQueue>;
  env?: NodeJS.ProcessEnv;
  closeDependencies?: boolean;
}

const PHASE_QUEUE_NAMES = [
  'sync-google',
  'validate-video',
  'select-daily-reels',
  'generate-content',
  'prepare-media',
  'publish-instagram',
  'cleanup-media',
  'mirror-sheet',
] as const;

const videoIdPattern = /^GCS-[0-9]{4,}$/;

function integrationReadiness(env: NodeJS.ProcessEnv) {
  return {
    contentGenerator: {
      provider: env['CONTENT_GENERATOR_PROVIDER']?.trim() || 'gemini',
      configured: Boolean(env['GEMINI_API_KEY']?.trim()),
      model: env['GEMINI_MODEL']?.trim() || null,
    },
    mediaStorage: {
      provider: env['MEDIA_STORAGE_PROVIDER']?.trim() || 'cloudinary',
      cloudinaryConfigured: Boolean(
        env['CLOUDINARY_CLOUD_NAME']?.trim() &&
        env['CLOUDINARY_API_KEY']?.trim() &&
        env['CLOUDINARY_API_SECRET']?.trim(),
      ),
      r2Configured: Boolean(
        env['R2_ACCOUNT_ID']?.trim() &&
        env['R2_ACCESS_KEY_ID']?.trim() &&
        env['R2_SECRET_ACCESS_KEY']?.trim() &&
        env['R2_BUCKET']?.trim(),
      ),
    },
    safety: {
      automationDefaultEnabled: env['AUTOMATION_ENABLED'] === 'true',
      metaPublishingEnabled: false,
      phaseBoundary: 'READY_FOR_PUBLISH',
    },
  };
}

function metaConfigurationStatus(meta: ReturnType<typeof loadConfig>['meta']) {
  const capability = new MetaGraphInstagramPublisher(meta).validateConfiguration();
  const identityConfigured = Boolean(meta.pageId && meta.instagramAccountId);
  const facebookIdentityMismatch =
    meta.authPath === 'facebook_login' && (!identityConfigured || !meta.identityMatchesExpected);
  return {
    implementationReadyForMetaCredentials: true,
    readyForFirstControlledMetaPublish: false,
    readiness: {
      state: 'BLOCKED',
      blockers: [
        ...(facebookIdentityMismatch ? ['META_EXPECTED_PAGE_IG_IDENTITY_NOT_CONFIGURED'] : []),
        'META_ACCOUNT_AND_PERMISSIONS_NOT_VERIFIED',
        'FIRST_CONTROLLED_STAGING_PUBLISH_NOT_APPROVED',
        'PUBLISHING_DISABLED_BY_PHASE_SAFETY',
      ],
    },
    configured:
      capability.configured &&
      meta.configured &&
      (meta.authPath === 'instagram_login' || meta.identityMatchesExpected),
    graphApiVersion: capability.graphApiVersion,
    authPath: meta.authPath,
    credentials: {
      accessTokenConfigured: Boolean(meta.accessToken),
      pageIdConfigured: Boolean(meta.pageId),
      accountIdConfigured: Boolean(meta.instagramAccountId),
      appIdConfigured: Boolean(meta.appId),
      appSecretConfigured: Boolean(meta.appSecret),
    },
    identity: {
      configuredPairMatchesExpected: identityConfigured && meta.identityMatchesExpected,
      externallyVerified: false,
    },
    accountCheck: { status: 'NOT_CHECKED', externalRequestMade: false },
    publishing: {
      configuredFlagEnabled: capability.publishingEnabled,
      effectiveEnabled: false,
      blockReason: 'META_PUBLISHING_DISABLED_UNTIL_CONTROLLED_STAGING_APPROVAL',
    },
    capabilities: capability.capabilities,
  };
}

function isLoopback(address: string): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function hasLocalAdminAccess(
  request: { ip: string; headers: Record<string, string | string[] | undefined> },
  env: NodeJS.ProcessEnv,
): boolean {
  const expected = env['ADMIN_API_TOKEN'];
  if (expected) {
    const authorization = request.headers['authorization'];
    if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) return false;
    const supplied = Buffer.from(authorization.slice(7));
    const secret = Buffer.from(expected);
    return supplied.length === secret.length && timingSafeEqual(supplied, secret);
  }
  return true;
}

function googleReadiness(env: NodeJS.ProcessEnv) {
  const credentials = getGoogleAuthStatus(env);
  const ids = {
    sheetId: env['GOOGLE_SHEET_ID']?.trim() || env['GOOGLE_SHEETS_SPREADSHEET_ID']?.trim() || null,
    videoFolderId:
      env['GOOGLE_VIDEO_FOLDER_ID']?.trim() || env['GOOGLE_DRIVE_FOLDER_ID']?.trim() || null,
    thumbnailFolderId: env['GOOGLE_THUMBNAIL_FOLDER_ID']?.trim() || null,
    archiveFolderId: env['GOOGLE_ARCHIVE_FOLDER_ID']?.trim() || null,
  };
  const archiveEnabled = env['GOOGLE_DRIVE_ARCHIVE_ENABLED'] === 'true';
  const missing = [
    ...(!credentials.configured ? ['credentials'] : []),
    ...(!ids.sheetId ? ['sheetId'] : []),
    ...(!ids.videoFolderId ? ['videoFolderId'] : []),
    ...(!ids.thumbnailFolderId ? ['thumbnailFolderId'] : []),
    ...(archiveEnabled && !ids.archiveFolderId ? ['archiveFolderId'] : []),
  ];
  return {
    ready: missing.length === 0,
    credentialsConfigured: credentials.configured,
    authType: credentials.authType,
    configuredIds: ids,
    missing,
  };
}

function safeJobState(
  job: Pick<Job, 'id' | 'timestamp' | 'finishedOn' | 'processedOn'> | undefined,
) {
  if (!job) return null;
  return {
    id: job.id ?? null,
    queuedAt: new Date(job.timestamp).toISOString(),
    startedAt: job.processedOn ? new Date(job.processedOn).toISOString() : null,
    finishedAt: job.finishedOn ? new Date(job.finishedOn).toISOString() : null,
  };
}

function createApiQueue(name: string, redis: RedisClient): Queue {
  const queue = new Queue(name, { connection: redis as never });
  // Queue connectivity is a readiness concern, never a process-liveness concern.
  // BullMQ emits connection/version failures asynchronously during initialization;
  // retain the error on the queue status surface instead of letting EventEmitter
  // turn it into an uncaught process error.
  queue.on('error', () => undefined);
  return queue;
}

async function safeQueueSnapshot(queue: GoogleSyncQueue): Promise<{
  counts: Record<string, number>;
  latest: Array<Pick<Job, 'id' | 'timestamp' | 'finishedOn' | 'processedOn'>>;
}> {
  try {
    const [counts, latest] = await Promise.all([
      queue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed'),
      queue.getJobs(['completed', 'failed', 'active', 'waiting', 'delayed'], 0, 0, false),
    ]);
    return { counts, latest };
  } catch {
    return { counts: {}, latest: [] };
  }
}

function businessDate(now: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const values = new Map(parts.map(({ type, value }) => [type, value]));
  return `${values.get('year')}-${values.get('month')}-${values.get('day')}`;
}

async function probe(action: () => Promise<unknown>, timeoutMs = 2_500): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve()
        .then(action)
        .then(
          () => true,
          () => false,
        ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function buildApp(deps: ApiDependencies = {}): Promise<FastifyInstance> {
  const env = deps.env ?? process.env;
  const config = loadConfig(env);
  const db = deps.db ?? createDatabaseClient();
  const redis =
    deps.redis ??
    new IORedis(config.redisUrl, {
      lazyConnect: true,
      connectTimeout: 2_000,
      commandTimeout: 2_000,
      maxRetriesPerRequest: 1,
      retryStrategy: () => null,
    });
  const closeDependencies = deps.closeDependencies ?? true;
  const syncQueue = deps.googleSyncQueue ?? createApiQueue('sync-google', redis);
  const phaseQueues =
    deps.phaseQueues ??
    Object.fromEntries(
      PHASE_QUEUE_NAMES.map((name) => [
        name,
        name === 'sync-google' ? syncQueue : createApiQueue(name, redis),
      ]),
    );
  const app = Fastify({
    logger: config.nodeEnv !== 'test',
    trustProxy: false,
    bodyLimit: 64 * 1024,
  });

  await app.register(helmet, {
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    referrerPolicy: { policy: 'no-referrer' },
  });
  app.addHook('onSend', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
    reply.header('x-content-type-options', 'nosniff');
  });

  app.get('/', async (_request, reply) => {
    reply.type('text/html').send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Reels Automation Engine</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; background: #0f172a; color: #f8fafc; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
    .card { background: #1e293b; padding: 2rem 2.5rem; border-radius: 12px; box-shadow: 0 10px 25px rgba(0,0,0,0.5); max-width: 480px; width: 100%; text-align: center; border: 1px solid #334155; }
    .status { display: inline-block; background: #10b981; color: #022c22; font-weight: bold; padding: 0.25rem 0.75rem; border-radius: 9999px; font-size: 0.875rem; margin-bottom: 1rem; }
    h1 { margin: 0.5rem 0 1rem; font-size: 1.5rem; }
    p { color: #94a3b8; font-size: 0.95rem; line-height: 1.5; margin-bottom: 1.5rem; }
    .links { display: flex; gap: 0.75rem; justify-content: center; }
    .links a { background: #3b82f6; color: white; text-decoration: none; padding: 0.5rem 1rem; border-radius: 6px; font-size: 0.875rem; font-weight: 500; }
    .links a.secondary { background: #334155; }
  </style>
</head>
<body>
  <div class="card">
    <div class="status">&#9679; System Live</div>
    <h1>Instagram Reels Automation</h1>
    <p>Unified Engine (Fastify API, Automation Worker &amp; Queue) is running successfully on Render.</p>
    <div class="links">
      <a href="/health">Health Check</a>
      <a href="/readiness">Readiness Status</a>
      <a href="/api/v1/dashboard" class="secondary">API JSON</a>
    </div>
  </div>
</body>
</html>`);
  });

  app.get('/health', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
    return { status: 'ok', service: 'api' };
  });

  app.get('/readiness', async (_request, reply) => {
    const [postgres, redisReady] = await Promise.all([
      probe(() => db.$queryRaw`SELECT 1`),
      probe(async () => {
        if (redis.status === 'wait') await redis.connect();
        if ((await redis.ping()) !== 'PONG') throw new Error('Redis ping did not return PONG');
      }),
    ]);
    const dependencies = {
      postgres: postgres ? 'ok' : 'unavailable',
      redis: redisReady ? 'ok' : 'unavailable',
    };
    const ready = dependencies.postgres === 'ok' && dependencies.redis === 'ok';
    reply.code(ready ? 200 : 503);
    return { status: ready ? 'ready' : 'not_ready', dependencies };
  });

  app.get('/api/v1/dashboard', async (_request, reply) => {
    const [
      groups,
      manualActions,
      schedules,
      setting,
      google,
      syncSnapshot,
      unmatched,
      openConflicts,
      videos,
    ] = await Promise.all([
      db.video.groupBy({ by: ['workflowStatus'], _count: { _all: true } }),
      db.video.count({ where: { manualActionRequired: true } }),
      db.schedule.findMany({
        where: { businessDate: businessDate(new Date(), config.timezone) },
        include: {
          video: {
            select: { videoId: true, title: true, workflowStatus: true, approvalStatus: true },
          },
          face: { select: { name: true } },
        },
        orderBy: { slotHour: 'asc' },
      }),
      db.automationSetting.findUnique({
        where: { key: 'automation.enabled' },
        select: { value: true, updatedAt: true },
      }),
      Promise.resolve(googleReadiness(env)),
      safeQueueSnapshot(syncQueue as unknown as GoogleSyncQueue),
      db.unmatchedThumbnail.count(),
      db.syncConflict.count({ where: { resolvedAt: null } }),
      db.video.findMany({
        orderBy: { updatedAt: 'desc' },
        take: 25,
        select: {
          videoId: true,
          title: true,
          approvalStatus: true,
          workflowStatus: true,
          face: { select: { name: true } },
          content: {
            orderBy: { version: 'desc' },
            take: 1,
            select: { version: true, caption: true, hashtags: true, cta: true },
          },
          schedule: {
            select: {
              businessDate: true,
              slotHour: true,
              mediaAsset: { select: { status: true } },
            },
          },
          publishAttempts: {
            orderBy: { createdAt: 'desc' },
            take: 1,
            select: { errorCode: true },
          },
          _count: { select: { publishAttempts: true } },
        },
      }),
    ]);
    const byStatus = Object.fromEntries(
      groups.map(({ workflowStatus, _count }) => [workflowStatus, _count._all]),
    );
    const count = (status: string) => byStatus[status] ?? 0;
    const slotsByHour = new Map(schedules.map((schedule) => [schedule.slotHour, schedule]));
    const slots = [19, 20].map((hour) => {
      const schedule = slotsByHour.get(hour);
      return {
        time: `${String(hour).padStart(2, '0')}:00`,
        scheduledAt: schedule?.scheduledAt.toISOString() ?? null,
        status: schedule?.status ?? 'OPEN',
        videoId: schedule?.video.videoId ?? null,
        title: schedule?.video.title ?? null,
        face: schedule?.face.name ?? null,
        workflowStatus: schedule?.video.workflowStatus ?? null,
        approvalStatus: schedule?.video.approvalStatus ?? null,
      };
    });
    reply.header('cache-control', 'no-store');
    return {
      businessDate: businessDate(new Date(), config.timezone),
      timezone: config.timezone,
      automation: {
        enabled: setting?.value === true,
        updatedAt: setting?.updatedAt.toISOString() ?? null,
        source: setting ? 'database' : 'default_off',
      },
      slots,
      counts: {
        waiting:
          count('WAITING_VIDEO') +
          count('WAITING_FACE') +
          count('WAITING_TITLE') +
          count('WAITING_THUMBNAIL') +
          count('WAITING_APPROVAL'),
        ready: count('READY'),
        scheduled:
          count('SELECTED') +
          count('CONTENT_GENERATING') +
          count('CONTENT_READY') +
          count('SCHEDULED') +
          count('PUBLISHING'),
        failed: count('FAILED') + count('RECONCILE_REQUIRED'),
        manualAction: manualActions,
        total: Object.values(byStatus).reduce((sum, value) => sum + value, 0),
      },
      google,
      sync: {
        lastSync: safeJobState(syncSnapshot.latest[0]),
        videosSeen: 0,
        unmatchedThumbnails: unmatched,
        openConflicts,
        errors: syncSnapshot.counts['failed'] ?? 0,
        pending: (syncSnapshot.counts['waiting'] ?? 0) + (syncSnapshot.counts['delayed'] ?? 0),
      },
      videos: videos.map((video) => ({
        videoId: video.videoId,
        title: video.title,
        face: video.face?.name ?? null,
        approvalStatus: video.approvalStatus,
        workflowStatus: video.workflowStatus,
        content: video.content[0] ?? null,
        scheduledDate: video.schedule?.businessDate ?? null,
        scheduledTime:
          video.schedule?.slotHour == null
            ? null
            : `${String(video.schedule.slotHour).padStart(2, '0')}:00`,
        contentGenerationStatus:
          video.workflowStatus === 'CONTENT_GENERATING'
            ? 'RUNNING'
            : video.content.length
              ? 'READY'
              : 'PENDING',
        durableMediaObjectStatus: video.schedule?.mediaAsset?.status ?? 'PENDING',
        deliveryUrlPolicy: 'EPHEMERAL_JIT',
        lastError: video.publishAttempts[0]?.errorCode ?? null,
        retryCount: video._count.publishAttempts,
      })),
    };
  });

  app.get('/api/v1/integrations/google/status', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
    return googleReadiness(env);
  });

  app.get('/api/v1/integrations/status', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
    return integrationReadiness(env);
  });

  app.get('/api/v1/integrations/meta/status', async (request, reply) => {
    if (!hasLocalAdminAccess(request, env))
      return reply.code(403).send({ error: 'Local admin access required' });
    reply.header('cache-control', 'no-store');
    return metaConfigurationStatus(config.meta);
  });

  // Safe alias for dashboard/configuration checks. This is intentionally read-only
  // and uses only local configuration validation; it never calls Meta.
  app.get('/api/v1/integrations/meta/readiness', async (request, reply) => {
    if (!hasLocalAdminAccess(request, env))
      return reply.code(403).send({ error: 'Local admin access required' });
    reply.header('cache-control', 'no-store');
    return metaConfigurationStatus(config.meta);
  });

  app.get('/api/v1/queues/status', async (_request, reply) => {
    const queues = await Promise.all(
      Object.entries(phaseQueues).map(async ([name, queue]) => {
        try {
          // BullMQ's scheduler getter creates an async promise that does not
          // propagate connection failures to this route. Check readiness first.
          await queue.waitUntilReady?.();
          const [counts, schedulers] = await Promise.all([
            queue.getJobCounts('waiting', 'active', 'delayed', 'completed', 'failed'),
            queue.getJobSchedulers?.(0, 20, true) ?? Promise.resolve([]),
          ]);
          return {
            name,
            available: true,
            counts: {
              waiting: counts['waiting'] ?? 0,
              active: counts['active'] ?? 0,
              delayed: counts['delayed'] ?? 0,
              completed: counts['completed'] ?? 0,
              failed: counts['failed'] ?? 0,
            },
            schedulers: schedulers.map((scheduler) => ({
              key: scheduler.key ?? null,
              name: scheduler.name ?? null,
              nextRunAt: scheduler.next ? new Date(scheduler.next).toISOString() : null,
              iterationCount: scheduler.iterationCount ?? null,
            })),
          };
        } catch {
          return {
            name,
            available: false,
            counts: { waiting: 0, active: 0, delayed: 0, completed: 0, failed: 0 },
            schedulers: [],
          };
        }
      }),
    );
    reply.header('cache-control', 'no-store');
    return {
      healthy: queues.every((queue) => queue.available),
      queues,
      metaPublishingEnabled: false,
    };
  });

  app.get('/api/v1/videos/:id/content', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!videoIdPattern.test(id)) return reply.code(400).send({ error: 'Invalid Video ID' });
    const video = await db.video.findUnique({
      where: { videoId: id },
      select: {
        videoId: true,
        title: true,
        face: { select: { name: true } },
        approvalStatus: true,
        workflowStatus: true,
        schedule: {
          select: {
            businessDate: true,
            slotHour: true,
            scheduledAt: true,
            mediaAsset: {
              select: {
                status: true,
                provider: true,
                contentType: true,
                sizeBytes: true,
                expiresAt: true,
              },
            },
          },
        },
        content: {
          orderBy: { version: 'desc' },
          take: 10,
          select: {
            version: true,
            caption: true,
            hashtags: true,
            cta: true,
            modelName: true,
            promptVersion: true,
            regenerated: true,
            createdAt: true,
          },
        },
      },
    });
    if (!video) return reply.code(404).send({ error: 'Video not found' });
    reply.header('cache-control', 'no-store');
    return {
      ...video,
      schedule: video.schedule
        ? {
            ...video.schedule,
            mediaAsset: video.schedule.mediaAsset
              ? {
                  ...video.schedule.mediaAsset,
                  // Prisma represents BIGINT as a JavaScript BigInt, which Fastify
                  // intentionally refuses to serialize.  Keep the API lossless and
                  // JSON-safe without exposing any storage URL or secret.
                  sizeBytes: video.schedule.mediaAsset.sizeBytes.toString(),
                }
              : null,
          }
        : null,
    };
  });

  async function enqueueVideoOperation(
    request: {
      ip: string;
      headers: Record<string, string | string[] | undefined>;
      params: unknown;
    },
    reply: FastifyReply,
    operation: 'generate' | 'regenerate' | 'prepare' | 'retry-content' | 'retry-media',
  ) {
    if (!hasLocalAdminAccess(request, env))
      return reply.code(403).send({ error: 'Local admin access required' });
    const { id } = request.params as { id: string };
    if (!videoIdPattern.test(id)) return reply.code(400).send({ error: 'Invalid Video ID' });
    const video = await db.video.findUnique({
      where: { videoId: id },
      select: { id: true, inputVersion: true, schedule: { select: { id: true } } },
    });
    if (!video) return reply.code(404).send({ error: 'Video not found' });
    const contentOperation = ['generate', 'regenerate', 'retry-content'].includes(operation);
    const queueName = contentOperation ? 'generate-content' : 'prepare-media';
    const queue = phaseQueues[queueName];
    if (!queue) return reply.code(503).send({ error: 'Queue is unavailable' });
    if (!contentOperation && !video.schedule)
      return reply.code(409).send({ error: 'Video has no schedule to prepare' });
    const uniqueAttempt = operation === 'regenerate' || operation === 'retry-media';
    const requestId = uniqueAttempt ? `${operation}-${id}-${Date.now()}` : undefined;
    const jobId =
      requestId ??
      (contentOperation
        ? `generate-${id}-v${video.inputVersion}`
        : `prepare-${video.schedule?.id ?? id}`);
    const job = await queue.add(
      operation,
      {
        videoId: id,
        ...(video.schedule ? { scheduleId: video.schedule.id } : {}),
        requestedAt: new Date().toISOString(),
        manual: true,
        regenerate: operation === 'regenerate',
        ...(requestId ? { requestId } : {}),
      },
      {
        jobId,
        attempts: contentOperation ? 4 : 3,
        backoff: { type: 'exponential', delay: 1_000 },
        removeOnComplete: 100,
        removeOnFail: 100,
      },
    );
    await db.auditLog.create({
      data: {
        actorId: 'local-admin',
        action: operation.toUpperCase().replaceAll('-', '_'),
        entity: 'Video',
        entityId: video.id,
        after: { queueName, jobId: job.id ?? jobId },
      },
    });
    reply.code(202).header('cache-control', 'no-store');
    return { queued: true, operation, jobId: job.id ?? jobId };
  }

  app.post('/api/v1/videos/:id/content/generate', (request, reply) =>
    enqueueVideoOperation(request, reply, 'generate'),
  );
  app.post('/api/v1/videos/:id/content/regenerate', (request, reply) =>
    enqueueVideoOperation(request, reply, 'regenerate'),
  );
  app.post('/api/v1/videos/:id/content/retry', (request, reply) =>
    enqueueVideoOperation(request, reply, 'retry-content'),
  );
  app.post('/api/v1/videos/:id/media/prepare', (request, reply) =>
    enqueueVideoOperation(request, reply, 'prepare'),
  );
  app.post('/api/v1/videos/:id/media/retry', (request, reply) =>
    enqueueVideoOperation(request, reply, 'retry-media'),
  );

  app.post('/api/v1/sync/google', async (request, reply) => {
    if (!hasLocalAdminAccess(request, env))
      return reply.code(403).send({ error: 'Local admin access required' });
    const google = googleReadiness(env);
    if (!google.ready)
      return reply
        .code(409)
        .send({ error: 'Google integration is not configured', missing: google.missing });
    const job = await syncQueue.add(
      'manual-sync',
      { requestedAt: new Date().toISOString() },
      {
        jobId: `manual-google-sync-${Date.now()}`,
        attempts: 4,
        backoff: { type: 'exponential', delay: 1_000 },
        removeOnComplete: 100,
        removeOnFail: 100,
      },
    );
    reply.code(202).header('cache-control', 'no-store');
    return { queued: true, jobId: job.id ?? null };
  });

  app.get('/api/v1/sync/google/status', async (_request, reply) => {
    const [counts, jobs] = await Promise.all([
      syncQueue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed'),
      syncQueue.getJobs(['completed', 'failed', 'active', 'waiting', 'delayed'], 0, 0, false),
    ]);
    reply.header('cache-control', 'no-store');
    return {
      counts,
      lastSync: safeJobState(jobs[0]),
      lastOutcome: jobs[0] ? (jobs[0].finishedOn ? 'finished' : 'running_or_queued') : 'never',
    };
  });

  app.get('/api/v1/sync/conflicts', async (request, reply) => {
    const query = request.query as { resolved?: string };
    const resolved = query.resolved === 'true';
    const conflicts = await db.syncConflict.findMany({
      where: { resolvedAt: resolved ? { not: null } : null },
      select: {
        id: true,
        source: true,
        video: { select: { videoId: true } },
        field: true,
        reason: true,
        resolvedAt: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    reply.header('cache-control', 'no-store');
    return {
      conflicts: conflicts.map((item) => ({
        id: item.id,
        source: item.source,
        videoId: item.video?.videoId ?? null,
        field: item.field,
        reason: item.reason,
        resolvedAt: item.resolvedAt?.toISOString() ?? null,
        createdAt: item.createdAt.toISOString(),
      })),
    };
  });

  app.post('/api/v1/sync/conflicts/:id/resolve', async (request, reply) => {
    if (!hasLocalAdminAccess(request, env))
      return reply.code(403).send({ error: 'Local admin access required' });
    const { id } = request.params as { id: string };
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id))
      return reply.code(400).send({ error: 'Invalid conflict ID' });
    const result = await db.syncConflict.updateMany({
      where: { id, resolvedAt: null },
      data: { resolvedAt: new Date() },
    });
    if (!result.count) return reply.code(404).send({ error: 'Open conflict not found' });
    reply.header('cache-control', 'no-store');
    return { resolved: true };
  });

  app.addHook('onClose', async () => {
    if (!closeDependencies) return;
    await Promise.allSettled(
      [...new Set(Object.values(phaseQueues))].map((queue) => queue.close()),
    );
    await Promise.allSettled([db.$disconnect(), redis.quit()]);
  });
  return app;
}
