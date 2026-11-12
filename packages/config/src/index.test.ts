import { describe, expect, it } from 'vitest';
import { expectedMetaIdentity, loadConfig, redisReconnectDelay, settingsSchema } from './index.js';

describe('configuration defaults', () => {
  it('uses a bounded Redis reconnect policy', () => {
    expect(redisReconnectDelay(1)).toBe(200);
    expect(redisReconnectDelay(10)).toBe(2_000);
    expect(redisReconnectDelay(100)).toBe(5_000);
  });

  it('keeps automation off and uses the agreed India schedule', () => {
    expect(loadConfig({})).toMatchObject({
      automationEnabled: false,
      timezone: 'Asia/Kolkata',
      dailyLimit: 2,
      faceGapDays: 2,
      publishSlots: ['19:00', '20:00'],
    });
  });

  it('rejects malformed slots and requires exactly two slots', () => {
    expect(() => settingsSchema.parse({ publishSlots: ['19:00'] })).toThrow();
    expect(() => settingsSchema.parse({ publishSlots: ['25:00', '20:00'] })).toThrow();
  });

  it('parses environment overrides without requiring integration credentials', () => {
    const config = loadConfig({ AUTOMATION_ENABLED: 'true', DAILY_REEL_LIMIT: '1' });
    expect(config.automationEnabled).toBe(true);
    expect(config.dailyLimit).toBe(1);
  });

  it('requires a canonical IANA timezone in runtime settings and environment', () => {
    expect(settingsSchema.parse({ timezone: 'Asia/Kolkata' }).timezone).toBe('Asia/Kolkata');
    expect(() => settingsSchema.parse({ timezone: 'Mars/Olympus' })).toThrow();
    expect(() => loadConfig({ APP_TIMEZONE: 'Mars/Olympus' })).toThrow();
  });

  it('validates optional Google resource IDs without requiring credentials', () => {
    expect(
      loadConfig({ GOOGLE_VIDEO_FOLDER_ID: 'folder_123', GOOGLE_SHEET_ID: 'sheet-123' }).google,
    ).toMatchObject({
      credentialsConfigured: false,
      videoFolderId: 'folder_123',
      sheetId: 'sheet-123',
    });
    expect(() => loadConfig({ GOOGLE_SHEET_ID: 'bad/id' })).toThrow();
  });

  it('accepts blank optional Meta credentials and token expiry placeholders', () => {
    expect(
      loadConfig({
        META_ACCESS_TOKEN: '',
        META_PAGE_ACCESS_TOKEN: '',
        META_PAGE_ID: '',
        INSTAGRAM_ACCOUNT_ID: '',
        META_APP_ID: '',
        META_APP_SECRET: '',
        META_TOKEN_EXPIRES_AT: '',
      }).meta,
    ).toMatchObject({
      accessToken: null,
      pageAccessToken: null,
      pageId: null,
      instagramAccountId: null,
      appId: null,
      appSecret: null,
      tokenExpiresAt: null,
      configured: false,
      publishingEnabled: false,
    });
  });

  it('accepts the canonical Facebook Login Page and Instagram pair', () => {
    const config = loadConfig({
      META_AUTH_PATH: 'facebook_login',
      META_PAGE_ACCESS_TOKEN: 'page-token',
      META_PAGE_ID: expectedMetaIdentity.facebookPageId,
      INSTAGRAM_ACCOUNT_ID: expectedMetaIdentity.instagramAccountId,
    });
    expect(config.meta).toMatchObject({
      authPath: 'facebook_login',
      accessToken: 'page-token',
      pageAccessToken: 'page-token',
      pageId: expectedMetaIdentity.facebookPageId,
      instagramAccountId: expectedMetaIdentity.instagramAccountId,
      configured: true,
      identityMatchesExpected: true,
    });
    expect(
      loadConfig({
        META_AUTH_PATH: 'facebook_login',
        META_ACCESS_TOKEN: 'legacy-token',
        META_PAGE_ID: expectedMetaIdentity.facebookPageId,
        INSTAGRAM_ACCOUNT_ID: expectedMetaIdentity.instagramAccountId,
      }).meta.pageAccessToken,
    ).toBe('legacy-token');
    expect(() => loadConfig({ META_PAGE_ID: 'not-a-numeric-id' })).toThrow();
  });

  it('defaults blank or whitespace REDIS_URL to local redis', () => {
    expect(loadConfig({ REDIS_URL: '' }).redisUrl).toBe('redis://127.0.0.1:6380');
    expect(loadConfig({ REDIS_URL: '   ' }).redisUrl).toBe('redis://127.0.0.1:6380');
  });

  it('retains the Instagram Login configuration path', () => {
    expect(
      loadConfig({
        META_AUTH_PATH: 'instagram_login',
        META_ACCESS_TOKEN: 'instagram-token',
        INSTAGRAM_ACCOUNT_ID: expectedMetaIdentity.instagramAccountId,
      }).meta,
    ).toMatchObject({
      authPath: 'instagram_login',
      accessToken: 'instagram-token',
      pageAccessToken: null,
      configured: true,
    });
  });
});
