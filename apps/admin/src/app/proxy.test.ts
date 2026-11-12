import { afterEach, describe, expect, it, vi } from 'vitest';
import { POST as approve } from './api/approvals/route';
import { POST as operate } from './api/operations/route';
import { PATCH as updateScheduling } from './api/settings/route';
import { POST as updateVideo } from './api/videos/route';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function request(
  path: string,
  body: unknown,
  authenticated = true,
  origin = 'https://dashboard.example',
) {
  return new Request(`https://dashboard.example${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin,
      ...(authenticated ? { authorization: `Basic ${btoa('admin:browser-password')}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe('dashboard server proxies', () => {
  it('authenticates the caller and enforces same origin independently of middleware', async () => {
    vi.stubEnv('DASHBOARD_PASSWORD', 'browser-password');
    vi.stubEnv('ADMIN_API_TOKEN', 'server-only-token');
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    expect((await approve(request('/api/approvals', {}, false))).status).toBe(401);
    expect(
      (await approve(request('/api/approvals', {}, true, 'https://attacker.example'))).status,
    ).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('injects the API token only into the bounded server request and never the response', async () => {
    vi.stubEnv('DASHBOARD_PASSWORD', 'browser-password');
    vi.stubEnv('ADMIN_API_TOKEN', 'server-only-token');
    vi.stubEnv('API_BASE_URL', 'https://api.example');
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ success: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const response = await approve(
      request('/api/approvals', {
        videoId: 'GCS-0021',
        decision: 'APPROVED',
        reason: '',
        expectedInputVersion: 2,
      }),
    );
    expect(response.status).toBe(200);
    expect(fetch).toHaveBeenCalledWith(
      'https://api.example/api/v1/videos/GCS-0021/approval',
      expect.objectContaining({
        headers: { 'content-type': 'application/json', authorization: 'Bearer server-only-token' },
      }),
    );
    const requestOptions = fetch.mock.calls[0]?.[1];
    expect(requestOptions?.signal).toBeInstanceOf(AbortSignal);
    expect(await response.text()).not.toContain('server-only-token');
  });

  it('rejects prototype action names and fails closed without a server token', async () => {
    vi.stubEnv('DASHBOARD_PASSWORD', 'browser-password');
    vi.stubEnv('ADMIN_API_TOKEN', '');
    expect(
      (await operate(request('/api/operations', { videoId: 'GCS-0021', action: 'toString' })))
        .status,
    ).toBe(400);
    expect((await approve(request('/api/approvals', { videoId: 'GCS-0021' }))).status).toBe(503);
  });

  it('keeps scheduling control on the authenticated server proxy', async () => {
    vi.stubEnv('DASHBOARD_PASSWORD', 'browser-password');
    vi.stubEnv('ADMIN_API_TOKEN', 'server-only-token');
    vi.stubEnv('API_BASE_URL', 'https://api.example');
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ schedulingAutomationEnabled: true }), { status: 200 }),
      );
    vi.stubGlobal('fetch', fetch);
    const response = await updateScheduling(
      new Request('https://dashboard.example/api/settings', {
        method: 'PATCH',
        headers: {
          'content-type': 'application/json',
          origin: 'https://dashboard.example',
          authorization: `Basic ${btoa('admin:browser-password')}`,
        },
        body: JSON.stringify({
          enabled: true,
          expectedVersion: 3,
          confirmation: 'ENABLE SCHEDULING',
        }),
      }),
    );
    expect(response.status).toBe(200);
    expect(fetch).toHaveBeenCalledWith(
      'https://api.example/api/v1/settings/scheduling',
      expect.objectContaining({
        method: 'PATCH',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer server-only-token',
        },
      }),
    );
  });

  it('updates human-owned title and face through bounded authenticated API commands', async () => {
    vi.stubEnv('DASHBOARD_PASSWORD', 'browser-password');
    vi.stubEnv('ADMIN_API_TOKEN', 'server-only-token');
    vi.stubEnv('API_BASE_URL', 'https://api.example');
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(() =>
        Promise.resolve(
          new Response(JSON.stringify({ workflowStatus: 'WAITING_APPROVAL' }), { status: 200 }),
        ),
      );
    vi.stubGlobal('fetch', fetch);

    const titleResponse = await updateVideo(
      request('/api/videos', { videoId: 'GCS-0021', field: 'title', value: 'Reviewed title' }),
    );
    const faceResponse = await updateVideo(
      request('/api/videos', { videoId: 'GCS-0021', field: 'face', value: 'Meera' }),
    );

    expect(titleResponse.status).toBe(200);
    expect(faceResponse.status).toBe(200);
    expect(fetch).toHaveBeenNthCalledWith(
      1,
      'https://api.example/api/v1/videos/GCS-0021/title',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ title: 'Reviewed title' }),
        headers: { 'content-type': 'application/json', authorization: 'Bearer server-only-token' },
      }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      'https://api.example/api/v1/videos/GCS-0021/face',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ faceName: 'Meera' }),
        headers: { 'content-type': 'application/json', authorization: 'Bearer server-only-token' },
      }),
    );
    expect(
      (
        await updateVideo(
          request('/api/videos', { videoId: 'GCS-0021', field: 'workflowStatus', value: 'READY' }),
        )
      ).status,
    ).toBe(400);
  });
});
