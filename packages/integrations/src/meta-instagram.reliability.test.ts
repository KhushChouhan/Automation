import { describe, expect, it, vi } from 'vitest';
import {
  META_REQUIRED_PERMISSIONS,
  MetaGraphInstagramPublisher,
  MetaPublishingDisabledError,
} from './index.js';
import type { MetaIntegrationError } from './index.js';

const graphHost = 'https://graph.instagram.com';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function fakeRequest(
  respond: (path: string) => Response | Promise<Response>,
): typeof fetch & { calls: Array<{ path: string; method: string }> } {
  const calls: Array<{ path: string; method: string }> = [];
  const request = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ path: url.pathname, method: init?.method ?? 'GET' });
    return respond(url.pathname);
  });
  Object.assign(request, { calls });
  return request as unknown as typeof fetch & {
    calls: Array<{ path: string; method: string }>;
  };
}

function publisher(
  request: typeof fetch,
  config: Partial<ConstructorParameters<typeof MetaGraphInstagramPublisher>[0]> = {},
) {
  return new MetaGraphInstagramPublisher(
    {
      graphApiVersion: 'v25.0',
      authPath: 'instagram_login',
      accessToken: 'fake-token-never-sent',
      instagramAccountId: 'configured-account-test',
      publishingEnabled: true,
      ...config,
    },
    request,
  );
}

const grantedPermissions = META_REQUIRED_PERMISSIONS.map((permission) => ({
  permission,
  status: 'granted',
}));

describe('Meta authentication and read-only safety contracts', () => {
  it('reports authentication failure for a revoked token without attempting any write', async () => {
    const request = fakeRequest(() => jsonResponse({ error: { code: 190 } }, 401));
    const client = publisher(request);

    await expect(client.validateToken()).rejects.toMatchObject({
      name: 'MetaIntegrationError',
      code: 'AUTH',
      retryable: false,
    } satisfies Partial<MetaIntegrationError>);
    expect(request.calls).toEqual([{ path: '/v25.0/me', method: 'GET' }]);
    expect(request.calls.every((call) => call.method === 'GET')).toBe(true);
  });

  it('rejects a token that resolves to the wrong configured account ID', async () => {
    const request = fakeRequest((path) => {
      if (path === '/v25.0/me')
        return jsonResponse({ id: 'different-account-test', account_type: 'BUSINESS' });
      if (path === '/v25.0/me/permissions') return jsonResponse({ data: grantedPermissions });
      return jsonResponse({});
    });
    const capability = await publisher(request).checkPublishingCapability();

    expect(capability.authenticated).toBe(true);
    expect(capability.account?.id).toBe('different-account-test');
    expect(capability.configuredAccountMatches).toBe(false);
    expect(capability.publishingPermission).toBe(false);
    expect(request.calls.every((call) => call.method === 'GET')).toBe(true);
  });

  it('reports the missing content-publish permission and remains read-only', async () => {
    const request = fakeRequest((path) => {
      if (path === '/v25.0/me')
        return jsonResponse({ id: 'configured-account-test', account_type: 'BUSINESS' });
      if (path === '/v25.0/me/permissions')
        return jsonResponse({
          data: [{ permission: 'instagram_business_basic', status: 'granted' }],
        });
      return jsonResponse({});
    });
    const capability = await publisher(request).checkPublishingCapability();

    expect(capability.permissions).toContainEqual({
      permission: 'instagram_business_content_publish',
      state: 'MISSING',
    });
    expect(capability.publishingPermission).toBe(false);
    expect(request.calls.every((call) => call.method === 'GET')).toBe(true);
    expect(request.calls.some((call) => call.method === 'POST')).toBe(false);
  });

  it('detects an expired token from local expiry metadata without a network request', async () => {
    const request = fakeRequest(() => jsonResponse({}));
    const client = publisher(request, { tokenExpiresAt: new Date(0) });

    await expect(client.checkTokenExpiry()).resolves.toMatchObject({ state: 'EXPIRED' });
    expect(request).not.toHaveBeenCalled();
  });

  it('blocks container and publish writes entirely while publishing is disabled', async () => {
    const request = fakeRequest(() => jsonResponse({ id: 'should-never-exist' }));
    const client = publisher(request, { publishingEnabled: false });

    await expect(
      client.createReelContainer({ videoUrl: 'https://fake.invalid/video.mp4', caption: 'test' }),
    ).rejects.toBeInstanceOf(MetaPublishingDisabledError);
    await expect(client.publishContainer('fake-container-test')).rejects.toBeInstanceOf(
      MetaPublishingDisabledError,
    );
    expect(request).not.toHaveBeenCalled();
    expect(request.calls).toEqual([]);
  });

  it('uses only injected fake transport and never targets a real Meta endpoint in this suite', async () => {
    const request = fakeRequest((path) => {
      if (path === '/v25.0/me')
        return jsonResponse({ id: 'configured-account-test', account_type: 'BUSINESS' });
      if (path === '/v25.0/me/permissions') return jsonResponse({ data: grantedPermissions });
      return jsonResponse({});
    });
    await publisher(request).checkPublishingCapability();

    expect(request).toHaveBeenCalled();
    expect(
      (request as unknown as { mock: { calls: Array<[unknown]> } }).mock.calls.every(([input]) =>
        String(input).startsWith(graphHost),
      ),
    ).toBe(true);
    expect(request.calls.every((call) => call.method === 'GET')).toBe(true);
  });
});
