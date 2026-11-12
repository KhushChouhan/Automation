import { describe, it, expect, vi } from 'vitest';
import type { PrismaClient } from '@gcs/database';
import type { Redis as RedisClient } from 'ioredis';
import { decideApproval, setAutomationSetting } from '@gcs/database';
import { buildApp } from './app.js';

vi.mock('@gcs/database', async (original) => ({
  ...(await original<object>()),
  decideApproval: vi.fn(),
  setAutomationSetting: vi.fn(),
}));
function fixture(env: NodeJS.ProcessEnv = { ADMIN_API_TOKEN: 'test-admin-token' }) {
  const video = {
    videoId: 'GCS-0021',
    title: 'Reviewed title',
    inputVersion: 7,
    driveFileId: 'drive_source_1',
    workflowStatus: 'WAITING_APPROVAL',
    approvalStatus: 'PENDING',
    face: { name: 'Meera' },
    thumbnail: { driveFileId: 'drive_cover_1', mimeType: 'image/jpeg' },
    approvals: [],
    content: [],
    postingHistory: null,
    schedule: null,
    publishAttempts: [
      {
        id: 'attempt-1',
        errorCode: 'https://provider.invalid/secret',
        status: 'FAILED',
        failureClass: 'UNKNOWN',
        reconcileRequiredAt: new Date(),
      },
    ],
  };
  const db = {
    video: {
      count: vi.fn<(args: { where: unknown }) => Promise<number>>().mockResolvedValue(1),
      findMany: vi
        .fn<(args: { where: unknown }) => Promise<(typeof video)[]>>()
        .mockResolvedValue([video]),
    },
    auditLog: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) },
    automationSetting: {
      findUnique: vi.fn().mockResolvedValue({ value: true, version: 3, updatedAt: new Date() }),
    },
  };
  const queue = {
    add: vi.fn(),
    getJobCounts: vi.fn().mockResolvedValue({}),
    getJobs: vi.fn().mockResolvedValue([]),
    close: vi.fn(),
  };
  return {
    db,
    deps: {
      db: db as unknown as PrismaClient,
      redis: { status: 'ready' } as unknown as RedisClient,
      googleSyncQueue: queue,
      phaseQueues: { 'select-daily-reels': queue },
      env,
      closeDependencies: false,
    },
    queue,
  };
}
const headers = { authorization: 'Bearer test-admin-token' };
describe('authenticated operator views and approval commands', () => {
  it('fails closed for every production operator route without a configured token', async () => {
    const { deps } = fixture({ NODE_ENV: 'production' });
    const app = await buildApp(deps);
    for (const url of [
      '/api/v1/dashboard',
      '/api/v1/videos',
      '/api/v1/approvals',
      '/api/v1/settings',
      '/api/v1/audit-events',
    ]) {
      expect((await app.inject({ url })).statusCode).toBe(403);
    }
    expect((await app.inject({ url: '/health' })).statusCode).toBe(200);
    await app.close();
  });
  it('requires authentication for inventory and shares the exact count and list predicate', async () => {
    const { deps, db } = fixture();
    const app = await buildApp(deps);
    expect((await app.inject({ url: '/api/v1/videos' })).statusCode).toBe(403);
    const result = await app.inject({ url: '/api/v1/videos?filter=failed&q=Meera', headers });
    expect(result.statusCode, result.body).toBe(200);
    expect(db.video.count.mock.calls[0]?.[0].where).toEqual(
      db.video.findMany.mock.calls[0]?.[0].where,
    );
    const payload = result.json<{ videos: Array<Record<string, unknown>> }>();
    expect(payload.videos[0]).toMatchObject({
      previewUrl: 'https://drive.google.com/file/d/drive_source_1/preview',
      thumbnailUrl: 'https://drive.google.com/file/d/drive_cover_1/preview',
      latestAttempt: { errorCode: 'PROVIDER_ERROR' },
    });
    expect(result.body).not.toContain('provider.invalid');
    expect((await app.inject({ url: '/api/v1/videos?filter=__proto__', headers })).statusCode).toBe(
      400,
    );
    expect((await app.inject({ url: '/api/v1/videos?offset=-1', headers })).statusCode).toBe(400);
    await app.close();
  });
  it('validates decisions and sends reviewed input version and reason to the transactional command', async () => {
    const { deps } = fixture();
    const app = await buildApp(deps);
    vi.mocked(decideApproval).mockResolvedValue({
      video: {
        videoId: 'GCS-0021',
        workflowStatus: 'WAITING_APPROVAL',
        approvalStatus: 'CHANGES_REQUIRED',
      },
      event: {},
    } as never);
    const invalid = await app.inject({
      method: 'POST',
      url: '/api/v1/videos/GCS-0021/approval',
      headers,
      payload: { decision: 'REJECTED', expectedInputVersion: 7, reason: '' },
    });
    expect(invalid.statusCode).toBe(400);
    const result = await app.inject({
      method: 'POST',
      url: '/api/v1/videos/GCS-0021/approval',
      headers,
      payload: {
        decision: 'CHANGES_REQUIRED',
        expectedInputVersion: 7,
        reason: '  Replace cover  ',
      },
    });
    expect(result.statusCode, result.body).toBe(200);
    expect(decideApproval).toHaveBeenLastCalledWith(deps.db, 'GCS-0021', {
      decision: 'CHANGES_REQUIRED',
      expectedInputVersion: 7,
      reason: 'Replace cover',
      actorId: 'admin-dashboard',
    });
    vi.mocked(decideApproval).mockRejectedValueOnce(new Error('STALE_INPUT'));
    const stale = await app.inject({
      method: 'POST',
      url: '/api/v1/videos/GCS-0021/approval',
      headers,
      payload: { decision: 'APPROVED', expectedInputVersion: 7, reason: '' },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.body).toContain('Refresh and review again');
    await app.close();
  });
  it('separates scheduling from Instagram write enablement and removes external diagnostic GET calls', async () => {
    const { deps, queue } = fixture();
    const app = await buildApp(deps);
    const result = await app.inject({ url: '/api/v1/settings', headers });
    expect(result.json()).toMatchObject({
      schedulingAutomationEnabled: true,
      instagramWriteEnabled: false,
      version: 3,
      readOnly: false,
    });
    vi.mocked(setAutomationSetting).mockResolvedValue({ value: false, version: 4 } as never);
    const disabled = await app.inject({
      method: 'PATCH',
      url: '/api/v1/settings/scheduling',
      headers,
      payload: { enabled: false, expectedVersion: 3 },
    });
    expect(disabled.statusCode, disabled.body).toBe(200);
    expect(setAutomationSetting).toHaveBeenCalledWith(deps.db, {
      key: 'automation.enabled',
      value: false,
      expectedVersion: 3,
      actorId: 'admin-dashboard',
    });
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: '/api/v1/settings/scheduling',
          headers,
          payload: { enabled: true, expectedVersion: 4, confirmation: 'wrong' },
        })
      ).statusCode,
    ).toBe(400);
    vi.mocked(setAutomationSetting).mockResolvedValue({ value: true, version: 5 } as never);
    const enabled = await app.inject({
      method: 'PATCH',
      url: '/api/v1/settings/scheduling',
      headers,
      payload: { enabled: true, expectedVersion: 4, confirmation: 'ENABLE SCHEDULING' },
    });
    expect(enabled.statusCode, enabled.body).toBe(200);
    expect(enabled.json()).toMatchObject({
      schedulingAutomationEnabled: true,
      selectionQueued: true,
      version: 5,
      instagramWriteEnabled: false,
    });
    expect(queue.add).toHaveBeenCalledWith(
      'settings-enabled',
      { source: 'admin-settings', manual: false },
      expect.objectContaining({ jobId: 'settings-selection-v5' }),
    );
    for (const url of ['/api/v1/integrations/gemini/models', '/api/v1/integrations/gemini/test'])
      expect((await app.inject({ url, headers })).statusCode).toBe(404);
    await app.close();
  });

  it('distinguishes live worker heartbeats from stale/malformed values without leaking payloads', async () => {
    const { deps } = fixture({ ADMIN_API_TOKEN: 'test-admin-token', APP_REVISION: 'api-abc123' });
    const get = vi.fn().mockResolvedValue(
      JSON.stringify({
        revision: 'worker-abc123',
        startedAt: new Date(Date.now() - 90_000).toISOString(),
        observedAt: new Date().toISOString(),
        queues: 8,
      }),
    );
    deps.redis = {
      status: 'ready',
      ping: vi.fn().mockResolvedValue('PONG'),
      get,
    } as unknown as RedisClient;
    deps.db = { ...deps.db, $queryRaw: vi.fn().mockResolvedValue([]) } as unknown as PrismaClient;
    const app = await buildApp(deps);
    const healthy = await app.inject({ url: '/api/v1/operations', headers });
    expect(healthy.json()).toMatchObject({
      revision: 'api-abc123',
      status: 'healthy',
      instagramWriteEnabled: false,
      worker: { status: 'healthy', revision: 'worker-abc123', queues: 8 },
    });
    get.mockResolvedValueOnce(
      JSON.stringify({
        revision: 'stale-worker',
        startedAt: new Date(Date.now() - 120_000).toISOString(),
        observedAt: new Date(Date.now() - 90_000).toISOString(),
        queues: 8,
      }),
    );
    expect((await app.inject({ url: '/api/v1/operations', headers })).json()).toMatchObject({
      status: 'degraded',
      worker: { status: 'stale' },
    });
    get.mockResolvedValueOnce('{secret-invalid-json');
    const invalid = await app.inject({ url: '/api/v1/operations', headers });
    expect(invalid.json()).toMatchObject({ worker: { status: 'unavailable' } });
    expect(invalid.body).not.toContain('secret-invalid-json');
    await app.close();
  });

  it('does not trust forwarded loopback addresses when API authentication is unconfigured', async () => {
    const { deps } = fixture({ NODE_ENV: 'test' });
    const app = await buildApp(deps);
    const response = await app.inject({
      url: '/api/v1/videos',
      remoteAddress: '203.0.113.5',
      headers: { 'x-forwarded-for': '127.0.0.1' },
    });
    expect(response.statusCode).toBe(403);
    await app.close();
  });
});
