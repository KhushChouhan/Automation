import { describe, expect, it } from 'vitest';
import { MetaGraphInstagramPublisher, MetaPublishingDisabledError } from './meta-instagram.js';

const baseConfig = {
  graphApiVersion: 'v25.0',
  accessToken: 'test-token',
  instagramAccountId: '17890000000000000',
  publishingEnabled: false,
};

function jsonFetch(
  routes: Record<string, { status?: number; body: unknown; headers?: Record<string, string> }>,
) {
  return ((input: unknown) => {
    const url = String(input);
    const route = Object.entries(routes).find(([suffix]) => url.includes(suffix))?.[1];
    if (!route) throw new Error(`Unexpected URL: ${url}`);
    return Promise.resolve(
      new Response(JSON.stringify(route.body), {
        status: route.status ?? 200,
        headers: { 'content-type': 'application/json', ...route.headers },
      }),
    );
  }) as typeof fetch;
}

describe('MetaGraphInstagramPublisher', () => {
  it('validates the configured Instagram Login account and permission contract with mock reads', async () => {
    const publisher = new MetaGraphInstagramPublisher(
      baseConfig,
      jsonFetch({
        '/me?fields=id,username,account_type': {
          body: {
            id: baseConfig.instagramAccountId,
            username: 'test-professional',
            account_type: 'BUSINESS',
          },
        },
        '/me/permissions': {
          body: {
            data: [
              { permission: 'instagram_business_basic', status: 'granted' },
              { permission: 'instagram_business_content_publish', status: 'granted' },
            ],
          },
        },
      }),
    );

    const capability = await publisher.checkPublishingCapability();
    expect(capability.authPath).toBe('INSTAGRAM_LOGIN');
    expect(capability.configuredAccountMatches).toBe(true);
    expect(capability.publishingPermission).toBe(true);
    expect(capability.account).toMatchObject({
      id: baseConfig.instagramAccountId,
      accountType: 'BUSINESS',
    });
    expect(capability.permissions.map((entry) => entry.state)).toEqual(['GRANTED', 'GRANTED']);
  });

  it('marks unavailable publishing-limit support without treating it as a publishing failure', async () => {
    const publisher = new MetaGraphInstagramPublisher(
      baseConfig,
      jsonFetch({
        '/content_publishing_limit': {
          status: 400,
          body: { error: { code: 100, type: 'OAuthException', fbtrace_id: 'safe-trace' } },
        },
      }),
    );
    await expect(publisher.checkPublishingLimit()).resolves.toEqual({
      supported: false,
      allowed: null,
      quotaUsage: null,
      quotaTotal: null,
    });
  });

  it('normalizes rate-limit metadata without retaining a token or payload', async () => {
    const publisher = new MetaGraphInstagramPublisher(
      baseConfig,
      jsonFetch({
        '/me?fields=id,username,account_type': {
          status: 429,
          headers: { 'retry-after': '12' },
          body: { error: { code: 4, type: 'OAuthException', fbtrace_id: 'safe-trace' } },
        },
      }),
    );
    await expect(publisher.validateToken()).rejects.toMatchObject({
      code: 'RATE_LIMIT',
      retryable: true,
      metadata: { httpStatus: 429, correlationId: 'safe-trace', retryAfterSeconds: 12 },
    });
  });

  it('refuses writes before invoking the injected request while publishing is disabled', async () => {
    let calls = 0;
    const publisher = new MetaGraphInstagramPublisher(baseConfig, () => {
      calls += 1;
      return Promise.resolve(new Response('{}'));
    });

    await expect(
      publisher.createReelContainer({
        videoUrl: 'https://media.invalid/reel.mp4',
        caption: 'safe',
      }),
    ).rejects.toBeInstanceOf(MetaPublishingDisabledError);
    expect(calls).toBe(0);
  });
});
