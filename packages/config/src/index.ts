import { z } from 'zod';

const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/;

function isIanaTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

const timezoneSchema = z.string().refine(isIanaTimeZone, 'Expected a valid IANA timezone');
const optionalTrimmed = z.preprocess(
  (value) => (typeof value === 'string' && !value.trim() ? undefined : value),
  z.string().trim().optional(),
);
const googleIdSchema = z.preprocess(
  (value) => (typeof value === 'string' && !value.trim() ? undefined : value),
  z
    .string()
    .trim()
    .min(1)
    .max(256)
    .regex(/^[a-zA-Z0-9_-]+$/)
    .optional(),
);
const metaIdSchema = z.preprocess(
  (value) => (typeof value === 'string' && !value.trim() ? undefined : value),
  z
    .string()
    .trim()
    .regex(/^\d{5,30}$/)
    .optional(),
);

export const expectedMetaIdentity = Object.freeze({
  facebookPageId: '1451833654672175',
  instagramAccountId: '17841443515116517',
});

export const settingsSchema = z.object({
  automationEnabled: z.boolean().default(false),
  timezone: timezoneSchema.default('Asia/Kolkata'),
  dailyLimit: z.number().int().positive().default(2),
  faceGapDays: z.number().int().nonnegative().default(2),
  publishSlots: z
    .array(z.string().regex(timePattern, 'Expected HH:mm'))
    .length(2)
    .default(['19:00', '20:00']),
});

export type AppSettings = z.infer<typeof settingsSchema>;

const envSchema = z.object({
  AUTOMATION_ENABLED: z.enum(['true', 'false']).default('false'),
  APP_TIMEZONE: timezoneSchema.default('Asia/Kolkata'),
  DAILY_REEL_LIMIT: z.coerce.number().int().positive().default(2),
  SAME_FACE_GAP_DAYS: z.coerce.number().int().nonnegative().default(2),
  SLOT_1: z.string().regex(timePattern, 'Expected HH:mm').default('19:00'),
  SLOT_2: z.string().regex(timePattern, 'Expected HH:mm').default('20:00'),
  REDIS_URL: z.preprocess(
    (value) => (typeof value === 'string' && !value.trim() ? undefined : value),
    z.string().url().default('redis://127.0.0.1:6379'),
  ),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  GOOGLE_AUTH_TYPE: z.enum(['oauth', 'service_account']).default('oauth'),
  GOOGLE_CLIENT_ID: optionalTrimmed,
  GOOGLE_CLIENT_SECRET: optionalTrimmed,
  GOOGLE_REFRESH_TOKEN: optionalTrimmed,
  GOOGLE_OAUTH_CLIENT_ID: optionalTrimmed,
  GOOGLE_OAUTH_CLIENT_SECRET: optionalTrimmed,
  GOOGLE_OAUTH_REFRESH_TOKEN: optionalTrimmed,
  GOOGLE_SERVICE_ACCOUNT_JSON: optionalTrimmed,
  GOOGLE_SHEET_ID: googleIdSchema,
  GOOGLE_SHEETS_SPREADSHEET_ID: googleIdSchema,
  GOOGLE_VIDEO_FOLDER_ID: googleIdSchema,
  GOOGLE_DRIVE_FOLDER_ID: googleIdSchema,
  GOOGLE_THUMBNAIL_FOLDER_ID: googleIdSchema,
  GOOGLE_ARCHIVE_FOLDER_ID: googleIdSchema,
  GOOGLE_DRIVE_ARCHIVE_ENABLED: z.enum(['true', 'false']).default('false'),
  GOOGLE_SYNC_INTERVAL_MINUTES: z.coerce.number().int().min(2).max(60).default(5),
  OPENAI_API_KEY: optionalTrimmed,
  OPENAI_MODEL: optionalTrimmed.default('gpt-5.6-luna'),
  CONTENT_GENERATOR_PROVIDER: z.enum(['gemini', 'openai']).default('gemini'),
  GEMINI_API_KEY: optionalTrimmed,
  GEMINI_MODEL: optionalTrimmed.default('gemini-3.8-flash'),
  GEMINI_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(30_000),
  GEMINI_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(6).default(3),
  CONTENT_PROMPT_VERSION: optionalTrimmed.default('real-estate-reels-v1'),
  CONTENT_SYSTEM_PROMPT: optionalTrimmed.default(
    'Create a concise Instagram real-estate reel caption from only the supplied approved title and metadata. Use natural Hinglish or English as appropriate. Include relevant hashtags and a short CTA. Never invent pricing, approvals, legal status, guaranteed returns, availability, or unsupported property facts.',
  ),
  OPENAI_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(30_000),
  OPENAI_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(6).default(3),
  DAILY_SELECTION_TIME: z.string().regex(timePattern, 'Expected HH:mm').default('06:00'),
  SCHEDULING_HORIZON_DAYS: z.coerce.number().int().min(1).max(366).default(90),
  MEDIA_STORAGE_PROVIDER: z.enum(['local', 'cloudinary', 'r2']).default('cloudinary'),
  MEDIA_URL_TTL_SECONDS: z.coerce.number().int().min(300).max(86_400).default(7_200),
  LOCAL_MEDIA_STORAGE_DIR: optionalTrimmed.default('.local/media-storage'),
  CLOUDINARY_CLOUD_NAME: optionalTrimmed,
  CLOUDINARY_API_KEY: optionalTrimmed,
  CLOUDINARY_API_SECRET: optionalTrimmed,
  R2_ACCOUNT_ID: optionalTrimmed,
  R2_ACCESS_KEY_ID: optionalTrimmed,
  R2_SECRET_ACCESS_KEY: optionalTrimmed,
  R2_BUCKET: optionalTrimmed,
  R2_ENDPOINT: optionalTrimmed,
  META_GRAPH_API_VERSION: z
    .string()
    .regex(/^v\d+\.\d+$/)
    .default('v25.0'),
  META_AUTH_PATH: z.enum(['facebook_login', 'instagram_login']).default('facebook_login'),
  META_PAGE_ACCESS_TOKEN: optionalTrimmed,
  META_ACCESS_TOKEN: optionalTrimmed,
  META_PAGE_ID: metaIdSchema,
  INSTAGRAM_ACCOUNT_ID: metaIdSchema,
  META_APP_ID: metaIdSchema,
  META_APP_SECRET: optionalTrimmed,
  META_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(15_000),
  META_DELIVERY_URL_TTL_SECONDS: z.coerce.number().int().min(3_600).max(86_400).default(14_400),
  META_TOKEN_EXPIRES_AT: z.preprocess(
    (value) => (typeof value === 'string' && !value.trim() ? undefined : value),
    z.string().datetime().optional(),
  ),
  INSTAGRAM_PUBLISHING_ENABLED: z.enum(['true', 'false']).default('false'),
});

export type AppConfig = AppSettings & {
  redisUrl: string;
  logLevel: z.infer<typeof envSchema>['LOG_LEVEL'];
  nodeEnv: z.infer<typeof envSchema>['NODE_ENV'];
  google: {
    authType: z.infer<typeof envSchema>['GOOGLE_AUTH_TYPE'];
    credentialsConfigured: boolean;
    sheetId: string | null;
    videoFolderId: string | null;
    thumbnailFolderId: string | null;
    archiveFolderId: string | null;
    archiveEnabled: boolean;
    syncIntervalMinutes: number;
  };
  content: {
    provider: 'gemini' | 'openai';
    configured: boolean;
    apiKey: string | null;
    model: string;
    promptVersion: string;
    systemPrompt: string;
    timeoutMs: number;
    maxAttempts: number;
  };
  orchestration: { dailySelectionTime: string; schedulingHorizonDays: number };
  media: {
    provider: 'local' | 'cloudinary' | 'r2';
    urlTtlSeconds: number;
    localDirectory: string;
    cloudinaryConfigured: boolean;
    cloudinary: {
      cloudName: string | null;
      apiKey: string | null;
      apiSecret: string | null;
    };
    r2Configured: boolean;
    r2: {
      accountId: string | null;
      accessKeyId: string | null;
      secretAccessKey: string | null;
      bucket: string | null;
      endpoint: string | null;
    };
  };
  meta: {
    graphApiVersion: string;
    authPath: 'facebook_login' | 'instagram_login';
    accessToken: string | null;
    pageAccessToken: string | null;
    pageId: string | null;
    instagramAccountId: string | null;
    appId: string | null;
    appSecret: string | null;
    timeoutMs: number;
    deliveryUrlTtlSeconds: number;
    tokenExpiresAt: Date | null;
    publishingEnabled: boolean;
    configured: boolean;
    identityMatchesExpected: boolean;
  };
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.parse(env);
  const metaAccessToken =
    parsed.META_AUTH_PATH === 'facebook_login'
      ? (parsed.META_PAGE_ACCESS_TOKEN ?? parsed.META_ACCESS_TOKEN ?? null)
      : (parsed.META_ACCESS_TOKEN ?? null);
  const settings = settingsSchema.parse({
    automationEnabled: parsed.AUTOMATION_ENABLED === 'true',
    timezone: parsed.APP_TIMEZONE,
    dailyLimit: parsed.DAILY_REEL_LIMIT,
    faceGapDays: parsed.SAME_FACE_GAP_DAYS,
    publishSlots: [parsed.SLOT_1, parsed.SLOT_2],
  });
  return {
    ...settings,
    redisUrl: parsed.REDIS_URL,
    logLevel: parsed.LOG_LEVEL,
    nodeEnv: parsed.NODE_ENV,
    google: {
      authType: parsed.GOOGLE_AUTH_TYPE,
      credentialsConfigured:
        parsed.GOOGLE_AUTH_TYPE === 'oauth'
          ? Boolean(
              (parsed.GOOGLE_CLIENT_ID ?? parsed.GOOGLE_OAUTH_CLIENT_ID) &&
              (parsed.GOOGLE_CLIENT_SECRET ?? parsed.GOOGLE_OAUTH_CLIENT_SECRET) &&
              (parsed.GOOGLE_REFRESH_TOKEN ?? parsed.GOOGLE_OAUTH_REFRESH_TOKEN),
            )
          : Boolean(parsed.GOOGLE_SERVICE_ACCOUNT_JSON),
      sheetId: parsed.GOOGLE_SHEET_ID ?? parsed.GOOGLE_SHEETS_SPREADSHEET_ID ?? null,
      videoFolderId: parsed.GOOGLE_VIDEO_FOLDER_ID ?? parsed.GOOGLE_DRIVE_FOLDER_ID ?? null,
      thumbnailFolderId: parsed.GOOGLE_THUMBNAIL_FOLDER_ID ?? null,
      archiveFolderId: parsed.GOOGLE_ARCHIVE_FOLDER_ID ?? null,
      archiveEnabled: parsed.GOOGLE_DRIVE_ARCHIVE_ENABLED === 'true',
      syncIntervalMinutes: parsed.GOOGLE_SYNC_INTERVAL_MINUTES,
    },
    content: {
      provider: parsed.CONTENT_GENERATOR_PROVIDER,
      configured:
        parsed.CONTENT_GENERATOR_PROVIDER === 'gemini'
          ? Boolean(parsed.GEMINI_API_KEY)
          : Boolean(parsed.OPENAI_API_KEY),
      apiKey:
        parsed.CONTENT_GENERATOR_PROVIDER === 'gemini'
          ? (parsed.GEMINI_API_KEY ?? null)
          : (parsed.OPENAI_API_KEY ?? null),
      model:
        parsed.CONTENT_GENERATOR_PROVIDER === 'gemini' ? parsed.GEMINI_MODEL : parsed.OPENAI_MODEL,
      promptVersion: parsed.CONTENT_PROMPT_VERSION,
      systemPrompt: parsed.CONTENT_SYSTEM_PROMPT,
      timeoutMs:
        parsed.CONTENT_GENERATOR_PROVIDER === 'gemini'
          ? parsed.GEMINI_TIMEOUT_MS
          : parsed.OPENAI_TIMEOUT_MS,
      maxAttempts:
        parsed.CONTENT_GENERATOR_PROVIDER === 'gemini'
          ? parsed.GEMINI_MAX_ATTEMPTS
          : parsed.OPENAI_MAX_ATTEMPTS,
    },
    orchestration: {
      dailySelectionTime: parsed.DAILY_SELECTION_TIME,
      schedulingHorizonDays: parsed.SCHEDULING_HORIZON_DAYS,
    },
    media: {
      provider: parsed.MEDIA_STORAGE_PROVIDER,
      urlTtlSeconds: parsed.MEDIA_URL_TTL_SECONDS,
      localDirectory: parsed.LOCAL_MEDIA_STORAGE_DIR,
      cloudinaryConfigured: Boolean(
        parsed.CLOUDINARY_CLOUD_NAME && parsed.CLOUDINARY_API_KEY && parsed.CLOUDINARY_API_SECRET,
      ),
      cloudinary: {
        cloudName: parsed.CLOUDINARY_CLOUD_NAME ?? null,
        apiKey: parsed.CLOUDINARY_API_KEY ?? null,
        apiSecret: parsed.CLOUDINARY_API_SECRET ?? null,
      },
      r2Configured: Boolean(
        parsed.R2_ACCOUNT_ID &&
        parsed.R2_ACCESS_KEY_ID &&
        parsed.R2_SECRET_ACCESS_KEY &&
        parsed.R2_BUCKET,
      ),
      r2: {
        accountId: parsed.R2_ACCOUNT_ID ?? null,
        accessKeyId: parsed.R2_ACCESS_KEY_ID ?? null,
        secretAccessKey: parsed.R2_SECRET_ACCESS_KEY ?? null,
        bucket: parsed.R2_BUCKET ?? null,
        endpoint: parsed.R2_ENDPOINT ?? null,
      },
    },
    meta: {
      graphApiVersion: parsed.META_GRAPH_API_VERSION,
      authPath: parsed.META_AUTH_PATH,
      accessToken: metaAccessToken,
      pageAccessToken: parsed.META_AUTH_PATH === 'facebook_login' ? metaAccessToken : null,
      pageId: parsed.META_PAGE_ID ?? null,
      instagramAccountId: parsed.INSTAGRAM_ACCOUNT_ID ?? null,
      appId: parsed.META_APP_ID ?? null,
      appSecret: parsed.META_APP_SECRET ?? null,
      timeoutMs: parsed.META_TIMEOUT_MS,
      deliveryUrlTtlSeconds: parsed.META_DELIVERY_URL_TTL_SECONDS,
      tokenExpiresAt: parsed.META_TOKEN_EXPIRES_AT ? new Date(parsed.META_TOKEN_EXPIRES_AT) : null,
      publishingEnabled: parsed.INSTAGRAM_PUBLISHING_ENABLED === 'true',
      configured: Boolean(
        metaAccessToken &&
        parsed.INSTAGRAM_ACCOUNT_ID &&
        (parsed.META_AUTH_PATH === 'instagram_login' || parsed.META_PAGE_ID),
      ),
      identityMatchesExpected:
        parsed.META_PAGE_ID === expectedMetaIdentity.facebookPageId &&
        parsed.INSTAGRAM_ACCOUNT_ID === expectedMetaIdentity.instagramAccountId,
    },
  };
}
