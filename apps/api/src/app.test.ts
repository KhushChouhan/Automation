import { describe, expect, it } from 'vitest';
import type { PrismaClient } from '@gcs/database';
import type { Redis as RedisClient } from 'ioredis';
import { buildApp } from './app.js';

function dependencies(overrides: Record<string, unknown> = {}) {
  const queue = {
    add: () => Promise.resolve({ id: 'manual-google-sync-1' }),
    getJobCounts: () =>
      Promise.resolve({ waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 }),
    getJobs: () => Promise.resolve([]),
    getJobSchedulers: () => Promise.resolve([]),
    close: () => Promise.resolve(),
  };
  const db = {
    $queryRaw: () => Promise.resolve([{ '?column?': 1 }]),
    video: {
      groupBy: () =>
        Promise.resolve([
          { workflowStatus: 'READY', _count: { _all: 3 } },
          { workflowStatus: 'WAITING_FACE', _count: { _all: 2 } },
        ]),
      count: () => Promise.resolve(1),
      findUnique: ({ where }: { where: { videoId?: string } }) =>
        Promise.resolve(
          where.videoId
            ? {
                id: 'video-db-id',
                inputVersion: 1,
                approvalStatus: 'APPROVED',
                workflowStatus: 'SCHEDULED',
                content: [{ id: 'content-db-id' }],
                schedule: { id: 'schedule-db-id', mediaAsset: { status: 'FAILED' } },
              }
            : null,
        ),
      findMany: () => Promise.resolve([]),
    },
    schedule: { findMany: () => Promise.resolve([]) },
    automationSetting: {
      findUnique: () =>
        Promise.resolve({ value: false, updatedAt: new Date('2026-10-27T00:00:00.000Z') }),
    },
    unmatchedThumbnail: { count: () => Promise.resolve(0) },
    syncConflict: {
      count: () => Promise.resolve(0),
      findMany: () => Promise.resolve([]),
      updateMany: () => Promise.resolve({ count: 1 }),
    },
    auditLog: { create: () => Promise.resolve({ id: 'audit-1' }) },
  };
  const redis = {
    status: 'ready',
    ping: () => Promise.resolve('PONG'),
    quit: () => Promise.resolve('OK'),
  };
  return {
    db: { ...db, ...overrides } as unknown as PrismaClient,
    redis: redis as unknown as RedisClient,
    googleSyncQueue: queue,
    phaseQueues: Object.fromEntries(
      [
        'sync-google',
        'validate-video',
        'select-daily-reels',
        'generate-content',
        'prepare-media',
        'publish-instagram',
        'cleanup-media',
        'mirror-sheet',
      ].map((name) => [name, queue]),
    ),
    env: {},
    closeDependencies: false,
    ...overrides,
  };
}

describe('operations API', () => {
  it('returns liveness without requiring dependencies', async () => {
    const app = await buildApp(dependencies());
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({ status: 'ok', service: 'api', revision: null });
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    await app.close();
  });

  it('reports Postgres and Redis readiness', async () => {
    const app = await buildApp(dependencies());
    const response = await app.inject({ method: 'GET', url: '/readiness' });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({
      status: 'ready',
      dependencies: { postgres: 'ok', redis: 'ok' },
    });
    await app.close();
  });

  it('returns 503 when either backing service fails its readiness probe', async () => {
    const app = await buildApp(
      dependencies({ $queryRaw: () => Promise.reject(new Error('unavailable')) }),
    );
    const response = await app.inject({ method: 'GET', url: '/readiness' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      status: 'not_ready',
      dependencies: { postgres: 'unavailable', redis: 'ok' },
    });
    await app.close();
  });

  it('serves dashboard inventory and open IST slot cards from its data providers', async () => {
    const app = await buildApp(dependencies());
    const response = await app.inject({ method: 'GET', url: '/api/v1/dashboard' });
    const body = response.json<{
      timezone: string;
      automation: { enabled: boolean };
      slots: Array<{ time: string }>;
      counts: { waiting: number; ready: number; manualAction: number; total: number };
    }>();
    expect(response.statusCode).toBe(200);
    expect(body.timezone).toBe('Asia/Kolkata');
    expect(body.automation.enabled).toBe(false);
    expect(body.slots.map((slot: { time: string }) => slot.time)).toEqual(['19:00', '20:00']);
    expect(body.counts).toMatchObject({ waiting: 2, ready: 3, manualAction: 1, total: 5 });
    expect(body).toHaveProperty('google.ready', false);
    expect(body).toHaveProperty('sync.openConflicts', 0);
    await app.close();
  });

  it('labels durable media readiness separately from ephemeral just-in-time delivery', async () => {
    const app = await buildApp(
      dependencies({
        video: {
          groupBy: () => Promise.resolve([]),
          count: () => Promise.resolve(0),
          findMany: () =>
            Promise.resolve([
              {
                videoId: 'GCS-0021',
                title: null,
                face: null,
                approvalStatus: 'APPROVED',
                workflowStatus: 'SCHEDULED',
                content: [],
                schedule: {
                  businessDate: '2026-10-29',
                  slotHour: 19,
                  mediaAsset: { status: 'READY' },
                },
                publishAttempts: [],
                _count: { publishAttempts: 0 },
              },
            ]),
        },
      }),
    );
    const response = await app.inject({ method: 'GET', url: '/api/v1/dashboard' });
    const body = response.json<{
      videos: Array<Record<string, unknown>>;
    }>();
    expect(response.statusCode).toBe(200);
    expect(body.videos[0]).toMatchObject({
      durableMediaObjectStatus: 'READY',
      deliveryUrlPolicy: 'EPHEMERAL_JIT',
    });
    expect(body.videos[0]).not.toHaveProperty('deliveryUrl');
    expect(response.body).not.toMatch(/https?:\/\//);
    await app.close();
  });

  it('reports Google configuration readiness without returning credential values', async () => {
    const app = await buildApp(
      dependencies({
        env: {
          GOOGLE_AUTH_TYPE: 'oauth',
          GOOGLE_CLIENT_ID: 'secret-client-id',
          GOOGLE_CLIENT_SECRET: 'secret-client-secret',
          GOOGLE_REFRESH_TOKEN: 'secret-refresh-token',
          GOOGLE_VIDEO_FOLDER_ID: 'local-folder-id',
          GOOGLE_THUMBNAIL_FOLDER_ID: 'local-thumbnail-folder-id',
          GOOGLE_SHEET_ID: 'local-sheet-id',
        },
      }),
    );
    const response = await app.inject({ method: 'GET', url: '/api/v1/integrations/google/status' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ready: true,
      credentialsConfigured: true,
      authType: 'oauth',
    });
    expect(response.body).not.toContain('secret-');
    const status = response.json<{ configuredIds: { videoFolderId: string | null } }>();
    expect(status.configuredIds.videoFolderId).toBe('local-folder-id');
    await app.close();
  });

  it('reports Phase 3 integration safety without exposing secret values', async () => {
    const app = await buildApp(
      dependencies({
        env: {
          CONTENT_GENERATOR_PROVIDER: 'gemini',
          GEMINI_API_KEY: 'secret-gemini-key',
          GEMINI_MODEL: 'gemini-3.6-flash',
          R2_ACCOUNT_ID: 'account',
          R2_ACCESS_KEY_ID: 'secret-r2-id',
          R2_SECRET_ACCESS_KEY: 'secret-r2-key',
          R2_BUCKET: 'reels',
          CLOUDINARY_CLOUD_NAME: 'cloud',
          CLOUDINARY_API_KEY: 'key',
          CLOUDINARY_API_SECRET: 'secret',
          AUTOMATION_ENABLED: 'false',
        },
      }),
    );
    const response = await app.inject({ method: 'GET', url: '/api/v1/integrations/status' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      contentGenerator: {
        provider: 'gemini',
        configured: true,
        model: 'gemini-3.6-flash',
      },
      mediaStorage: {
        provider: 'cloudinary',
        cloudinaryConfigured: true,
        r2Configured: true,
      },
      safety: {
        automationDefaultEnabled: false,
        metaPublishingEnabled: false,
        phaseBoundary: 'READY_FOR_PUBLISH',
      },
    });
    expect(response.body).not.toContain('secret-');
    await app.close();
  });

  it('reports Meta configuration presence without returning secrets or contacting Meta', async () => {
    const token = 'meta-token-never-return';
    const appSecret = 'meta-app-secret-never-return';
    const accountId = '17841443515116517';
    const pageId = '1451833654672175';
    const appId = '987654321';
    const app = await buildApp(
      dependencies({
        env: {
          META_GRAPH_API_VERSION: 'v25.0',
          META_AUTH_PATH: 'facebook_login',
          META_PAGE_ACCESS_TOKEN: token,
          META_PAGE_ID: pageId,
          INSTAGRAM_ACCOUNT_ID: accountId,
          META_APP_ID: appId,
          META_APP_SECRET: appSecret,
          INSTAGRAM_PUBLISHING_ENABLED: 'true',
        },
      }),
    );
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/integrations/meta/status',
    });
    const status = response.json<{
      configured: boolean;
      graphApiVersion: string;
      credentials: Record<string, boolean>;
      accountCheck: { status: string; externalRequestMade: boolean };
      publishing: {
        configuredFlagEnabled: boolean;
        effectiveEnabled: boolean;
        blockReason: string;
      };
      implementationReadyForMetaCredentials: boolean;
      readyForFirstControlledMetaPublish: boolean;
      readiness: { state: string; blockers: string[] };
      capabilities: Record<string, string>;
    }>();

    expect(response.statusCode).toBe(200);
    expect(status).toMatchObject({
      configured: true,
      graphApiVersion: 'v25.0',
      authPath: 'facebook_login',
      credentials: {
        accessTokenConfigured: true,
        pageIdConfigured: true,
        accountIdConfigured: true,
        appIdConfigured: true,
        appSecretConfigured: true,
      },
      accountCheck: { status: 'NOT_CHECKED', externalRequestMade: false },
      identity: { configuredPairMatchesExpected: true, externallyVerified: false },
      publishing: {
        configuredFlagEnabled: true,
        effectiveEnabled: false,
        blockReason: 'META_PUBLISHING_DISABLED_UNTIL_CONTROLLED_STAGING_APPROVAL',
      },
      implementationReadyForMetaCredentials: true,
      readyForFirstControlledMetaPublish: false,
      readiness: {
        state: 'BLOCKED',
        blockers: [
          'META_ACCOUNT_AND_PERMISSIONS_NOT_VERIFIED',
          'FIRST_CONTROLLED_STAGING_PUBLISH_NOT_APPROVED',
          'PUBLISHING_DISABLED_BY_PHASE_SAFETY',
        ],
      },
      capabilities: { reelPublish: 'SUPPORTED', customCover: 'REQUIRES_VERIFICATION' },
    });
    for (const secret of [token, appSecret, accountId, pageId, appId])
      expect(response.body).not.toContain(secret);
    const readiness = await app.inject({
      method: 'GET',
      url: '/api/v1/integrations/meta/readiness',
    });
    expect(readiness.statusCode).toBe(200);
    expect(readiness.json()).toEqual(status);
    for (const secret of [token, appSecret, accountId, pageId, appId])
      expect(readiness.body).not.toContain(secret);
    await app.close();
  });

  it('requires local admin access for Meta status and readiness', async () => {
    const app = await buildApp(
      dependencies({ env: { ADMIN_API_TOKEN: 'admin-secret-never-log' } }),
    );
    for (const url of ['/api/v1/integrations/meta/status', '/api/v1/integrations/meta/readiness']) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(403);
      expect(response.body).not.toContain('admin-secret-never-log');
    }
    await app.close();
  });

  it('blocks a Facebook Login Page and Instagram identity mismatch locally', async () => {
    const app = await buildApp(
      dependencies({
        env: {
          META_AUTH_PATH: 'facebook_login',
          META_PAGE_ACCESS_TOKEN: 'page-token-never-return',
          META_PAGE_ID: '1451833654672175',
          INSTAGRAM_ACCOUNT_ID: '17841443515116518',
        },
      }),
    );
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/integrations/meta/readiness',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      configured: false,
      identity: { configuredPairMatchesExpected: false, externallyVerified: false },
      publishing: { effectiveEnabled: false },
    });
    expect(response.json<{ readiness: { blockers: string[] } }>().readiness.blockers).toContain(
      'META_EXPECTED_PAGE_IG_IDENTITY_NOT_CONFIGURED',
    );
    expect(response.body).not.toContain('page-token-never-return');
    await app.close();
  });

  it('returns bounded queue counts and scheduler summaries', async () => {
    const app = await buildApp(dependencies());
    const response = await app.inject({ method: 'GET', url: '/api/v1/queues/status' });
    const body = response.json<{
      healthy: boolean;
      metaPublishingEnabled: boolean;
      queues: Array<{ name: string; counts: { failed: number }; schedulers: unknown[] }>;
    }>();
    expect(response.statusCode).toBe(200);
    expect(body.healthy).toBe(true);
    expect(body.metaPublishingEnabled).toBe(false);
    expect(body.queues).toHaveLength(8);
    expect(body.queues.every((queue) => queue.counts.failed === 0)).toBe(true);
    expect(body.queues.every((queue) => queue.schedulers.length === 0)).toBe(true);
    await app.close();
  });

  it('contains queue startup rejection and reports the queue unavailable', async () => {
    let readinessChecks = 0;
    let schedulerChecks = 0;
    const unavailableQueue = {
      waitUntilReady: () => {
        readinessChecks += 1;
        return Promise.reject(new Error('Unsupported Redis version'));
      },
      getJobCounts: () => Promise.reject(new Error('Unsupported Redis version')),
      getJobSchedulers: () => {
        schedulerChecks += 1;
        return Promise.reject(new Error('Scheduler must not initialize'));
      },
      getJobs: () => Promise.resolve([]),
      close: () => Promise.resolve(),
    };
    const app = await buildApp(
      dependencies({ phaseQueues: { 'publish-instagram': unavailableQueue } }),
    );
    const response = await app.inject({ method: 'GET', url: '/api/v1/queues/status' });
    expect(readinessChecks).toBe(1);
    expect(schedulerChecks).toBe(0);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      healthy: false,
      queues: [{ name: 'publish-instagram', available: false }],
      metaPublishingEnabled: false,
    });
    await app.close();
  });

  it('queues local-admin content and media controls and audits the request', async () => {
    const jobIds: string[] = [];
    const actionQueue = {
      add: (_name: string, _data: Record<string, unknown>, options?: Record<string, unknown>) => {
        const requestedJobId = options?.['jobId'];
        const id = typeof requestedJobId === 'string' ? requestedJobId : 'missing-job-id';
        jobIds.push(id);
        return Promise.resolve({ id });
      },
      getJobCounts: () => Promise.resolve({}),
      getJobs: () => Promise.resolve([]),
      getJobSchedulers: () => Promise.resolve([]),
      close: () => Promise.resolve(),
    };
    const app = await buildApp(
      dependencies({
        phaseQueues: {
          'generate-content': actionQueue,
          'prepare-media': actionQueue,
        },
      }),
    );
    for (const url of [
      '/api/v1/videos/GCS-0021/content/generate',
      '/api/v1/videos/GCS-0021/content/regenerate',
      '/api/v1/videos/GCS-0021/content/retry',
      '/api/v1/videos/GCS-0021/media/prepare',
      '/api/v1/videos/GCS-0021/media/retry',
    ]) {
      const response = await app.inject({ method: 'POST', url });
      expect(response.statusCode, response.body).toBe(202);
      expect(response.json()).toMatchObject({ queued: true });
    }
    const secondRetry = await app.inject({
      method: 'POST',
      url: '/api/v1/videos/GCS-0021/content/retry',
    });
    expect(secondRetry.statusCode, secondRetry.body).toBe(202);
    const retryIds = jobIds.filter((id) => id.startsWith('retry-content-GCS-0021-'));
    expect(retryIds).toHaveLength(2);
    expect(new Set(retryIds).size).toBe(2);
    expect(jobIds).toContain('generate-GCS-0021-v1');
    expect(jobIds).toContain('prepare-schedule-db-id');
    const invalid = await app.inject({
      method: 'POST',
      url: '/api/v1/videos/not-a-video/content/generate',
    });
    expect(invalid.statusCode).toBe(400);
    await app.close();
  });

  it('queues manual sync only on loopback and when Google is ready', async () => {
    const app = await buildApp(
      dependencies({
        env: {
          GOOGLE_AUTH_TYPE: 'oauth',
          GOOGLE_CLIENT_ID: 'id',
          GOOGLE_CLIENT_SECRET: 'secret',
          GOOGLE_REFRESH_TOKEN: 'refresh',
          GOOGLE_VIDEO_FOLDER_ID: 'folder',
          GOOGLE_THUMBNAIL_FOLDER_ID: 'thumbs',
          GOOGLE_SHEET_ID: 'sheet',
        },
      }),
    );
    const response = await app.inject({ method: 'POST', url: '/api/v1/sync/google' });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ queued: true, jobId: 'manual-google-sync-1' });
    await app.close();

    const unconfigured = await buildApp(dependencies());
    const rejected = await unconfigured.inject({ method: 'POST', url: '/api/v1/sync/google' });
    expect(rejected.statusCode).toBe(409);
    await unconfigured.close();
  });

  it('lists and resolves conflicts using summary fields only', async () => {
    const app = await buildApp(
      dependencies({
        syncConflict: {
          count: () => Promise.resolve(1),
          findMany: () =>
            Promise.resolve([
              {
                id: 'conflict-1',
                source: 'SHEET',
                video: { videoId: 'GCS-0001' },
                field: 'title',
                reason: 'CONCURRENT_EDIT',
                resolvedAt: null,
                createdAt: new Date('2026-10-27T00:00:00.000Z'),
              },
            ]),
          updateMany: () => Promise.resolve({ count: 1 }),
        },
      }),
    );
    const listed = await app.inject({ method: 'GET', url: '/api/v1/sync/conflicts' });
    const conflictBody = listed.json<{
      conflicts: Array<{ id: string; videoId: string | null }>;
    }>();
    expect(conflictBody.conflicts[0]).toMatchObject({ id: 'conflict-1', videoId: 'GCS-0001' });
    expect(listed.body).not.toContain('databaseValue');
    const resolved = await app.inject({
      method: 'POST',
      url: '/api/v1/sync/conflicts/conflict-1/resolve',
    });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json()).toEqual({ resolved: true });
    await app.close();
  });

  it('requires the optional admin bearer token for local mutation routes', async () => {
    const app = await buildApp(dependencies({ env: { ADMIN_API_TOKEN: 'local-admin-secret' } }));
    const denied = await app.inject({ method: 'POST', url: '/api/v1/sync/google' });
    expect(denied.statusCode).toBe(403);
    await app.close();
  });
});
