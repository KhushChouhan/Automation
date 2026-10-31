/** Supports the explicit Instagram Login and Facebook Login credential paths. */
export const META_REQUIRED_PERMISSIONS = [
  'instagram_business_basic',
  'instagram_business_content_publish',
] as const;

export const META_FACEBOOK_LOGIN_REQUIRED_PERMISSIONS = [
  'pages_show_list',
  'pages_read_engagement',
  'instagram_basic',
  'instagram_content_publish',
] as const;

export type MetaRequiredPermission =
  | (typeof META_REQUIRED_PERMISSIONS)[number]
  | (typeof META_FACEBOOK_LOGIN_REQUIRED_PERMISSIONS)[number];
export type MetaFeatureSupport = 'SUPPORTED' | 'UNSUPPORTED' | 'REQUIRES_VERIFICATION';
export type MetaPermissionState = 'GRANTED' | 'MISSING' | 'UNKNOWN';
export type MetaTokenExpiryState = 'VALID' | 'EXPIRING_SOON' | 'EXPIRED' | 'UNKNOWN';
export type MetaFailureCode =
  | 'AUTH'
  | 'PERMISSION'
  | 'ACCOUNT_NOT_ELIGIBLE'
  | 'APP_REVIEW_REQUIRED'
  | 'RATE_LIMIT'
  | 'PUBLISH_LIMIT'
  | 'INVALID_MEDIA'
  | 'MEDIA_PROCESSING_FAILED'
  | 'INVALID_CAPTION'
  | 'FEATURE_UNSUPPORTED'
  | 'NETWORK'
  | 'TIMEOUT'
  | 'TRANSIENT_SERVER'
  | 'UNKNOWN_PROVIDER_ERROR';

export const instagramReelCapabilityMatrix = {
  reelPublish: 'SUPPORTED',
  captionAndHashtags: 'SUPPORTED',
  shareToFeed: 'SUPPORTED',
  customCover: 'REQUIRES_VERIFICATION',
  userTagging: 'REQUIRES_VERIFICATION',
  collaborator: 'REQUIRES_VERIFICATION',
  locationTagging: 'REQUIRES_VERIFICATION',
} as const satisfies Record<string, MetaFeatureSupport>;

export interface InstagramPublisherConfiguration {
  graphApiVersion: string;
  authPath?: 'facebook_login' | 'instagram_login';
  accessToken: string | null;
  instagramAccountId: string | null;
  pageId?: string | null;
  pageAccessToken?: string | null;
  publishingEnabled: boolean;
  timeoutMs?: number;
  tokenExpiresAt?: Date | null;
}

export interface MetaErrorMetadata {
  httpStatus: number | null;
  providerCode: string | null;
  providerType: string | null;
  providerSubcode: string | null;
  correlationId: string | null;
  retryAfterSeconds: number | null;
}

export class MetaIntegrationError extends Error {
  constructor(
    readonly code: MetaFailureCode,
    message: string,
    readonly retryable: boolean,
    readonly metadata: MetaErrorMetadata,
  ) {
    super(message);
    this.name = 'MetaIntegrationError';
  }
}

export interface InstagramAccount {
  id: string;
  username: string | null;
  accountType: 'BUSINESS' | 'CREATOR' | 'UNKNOWN';
}

export interface PermissionCheck {
  permission: MetaRequiredPermission;
  state: MetaPermissionState;
}

export interface TokenExpiryCheck {
  state: MetaTokenExpiryState;
  expiresAt: Date | null;
}

export interface InstagramPublishingCapability {
  configured: boolean;
  authenticated: boolean | null;
  accountAccessible: boolean | null;
  publishingPermission: boolean | null;
  tokenExpiresAt: Date | null;
  graphApiVersion: string;
  publishingEnabled: boolean;
  authPath: 'FACEBOOK_LOGIN' | 'INSTAGRAM_LOGIN';
  account: InstagramAccount | null;
  configuredAccountMatches: boolean | null;
  permissions: PermissionCheck[];
  tokenExpiry: TokenExpiryCheck;
  capabilities: typeof instagramReelCapabilityMatrix;
}

export interface PublishingLimitStatus {
  supported: boolean | null;
  allowed: boolean | null;
  quotaUsage: number | null;
  quotaTotal: number | null;
}

export interface ReelContainerInput {
  videoUrl: string;
  caption: string;
  shareToFeed?: boolean;
  coverUrl?: string;
}

export interface ReelContainerStatus {
  containerId: string;
  status: 'IN_PROGRESS' | 'FINISHED' | 'ERROR' | 'EXPIRED' | 'PUBLISHED' | 'UNKNOWN';
  errorMessage?: string;
}

export interface PublishedInstagramMedia {
  mediaId: string;
  permalink: string | null;
}

export class MetaPublishingDisabledError extends Error {
  constructor() {
    super('Instagram publishing is disabled by deployment safety configuration');
    this.name = 'MetaPublishingDisabledError';
  }
}

export interface InstagramPublisher {
  validateConfiguration(): InstagramPublishingCapability;
  validateToken(): Promise<InstagramAccount>;
  getAuthenticatedInstagramAccount(): Promise<InstagramAccount>;
  verifyConfiguredAccountId(): Promise<boolean>;
  checkRequiredPermissions(): Promise<PermissionCheck[]>;
  checkTokenExpiry(): Promise<TokenExpiryCheck>;
  checkPublishingCapability(): Promise<InstagramPublishingCapability>;
  checkPublishingLimit(): Promise<PublishingLimitStatus>;
  createReelContainer(input: ReelContainerInput): Promise<{ containerId: string }>;
  getContainerStatus(containerId: string): Promise<ReelContainerStatus>;
  publishContainer(containerId: string): Promise<{ mediaId: string }>;
  getPublishedMedia(mediaId: string): Promise<PublishedInstagramMedia>;
  reconcilePublish(containerId: string, mediaId?: string): Promise<PublishedInstagramMedia | null>;
}

type MetaFetch = typeof fetch;
type MetaJson = Record<string, unknown>;

function isRecord(value: unknown): value is MetaJson {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringField(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function readRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

function emptyMetadata(): MetaErrorMetadata {
  return {
    httpStatus: null,
    providerCode: null,
    providerType: null,
    providerSubcode: null,
    correlationId: null,
    retryAfterSeconds: null,
  };
}

function classifyMetaError(
  status: number,
  body: unknown,
  retryAfter: string | null,
): MetaIntegrationError {
  const error = isRecord(body) && isRecord(body['error']) ? body['error'] : {};
  const providerCode =
    stringField(error['code']) ??
    (typeof error['code'] === 'number' ? String(error['code']) : null);
  const providerType = stringField(error['type']);
  const providerSubcode =
    stringField(error['error_subcode']) ??
    (typeof error['error_subcode'] === 'number' ? String(error['error_subcode']) : null);
  const metadata: MetaErrorMetadata = {
    httpStatus: status,
    providerCode,
    providerType,
    providerSubcode,
    correlationId: stringField(error['fbtrace_id']),
    retryAfterSeconds: readRetryAfter(retryAfter),
  };
  if (status === 401 || status === 403 || providerCode === '190')
    return new MetaIntegrationError('AUTH', 'Meta request failed', false, metadata);
  if (status === 429 || providerCode === '4' || providerCode === '17' || providerCode === '32')
    return new MetaIntegrationError('RATE_LIMIT', 'Meta request failed', true, metadata);
  if (status >= 500)
    return new MetaIntegrationError('TRANSIENT_SERVER', 'Meta request failed', true, metadata);
  if (providerCode === '10' || providerCode === '200')
    return new MetaIntegrationError('PERMISSION', 'Meta request failed', false, metadata);
  if (providerCode === '100')
    return new MetaIntegrationError('FEATURE_UNSUPPORTED', 'Meta request failed', false, metadata);
  return new MetaIntegrationError('UNKNOWN_PROVIDER_ERROR', 'Meta request failed', false, metadata);
}

export class MetaGraphInstagramPublisher implements InstagramPublisher {
  constructor(
    private readonly config: InstagramPublisherConfiguration,
    private readonly request: MetaFetch = fetch,
  ) {}

  validateConfiguration(): InstagramPublishingCapability {
    const expiresAt = this.config.tokenExpiresAt ?? null;
    return {
      configured: Boolean(this.config.accessToken && this.config.instagramAccountId),
      authenticated: null,
      accountAccessible: null,
      publishingPermission: null,
      tokenExpiresAt: expiresAt,
      graphApiVersion: this.config.graphApiVersion,
      publishingEnabled: this.config.publishingEnabled,
      authPath: this.authPathLabel(),
      account: null,
      configuredAccountMatches: null,
      permissions: this.requiredPermissions().map((permission) => ({
        permission,
        state: 'UNKNOWN',
      })),
      tokenExpiry: this.expiryState(expiresAt),
      capabilities: instagramReelCapabilityMatrix,
    };
  }

  async validateToken(): Promise<InstagramAccount> {
    if (this.isFacebookLogin()) {
      const page = await this.read(`/${this.requiredPageId()}?fields=id,name`);
      if (stringField(page['id']) !== this.requiredPageId())
        throw new MetaIntegrationError(
          'AUTH',
          'Meta token did not identify the configured Page',
          false,
          emptyMetadata(),
        );
    }
    return this.getAuthenticatedInstagramAccount();
  }

  async getAuthenticatedInstagramAccount(): Promise<InstagramAccount> {
    if (this.isFacebookLogin()) {
      const result = await this.read(
        `/${this.requiredPageId()}?fields=instagram_business_account{id,username}`,
      );
      const linked = result['instagram_business_account'];
      if (!isRecord(linked) || !stringField(linked['id']))
        throw new MetaIntegrationError(
          'ACCOUNT_NOT_ELIGIBLE',
          'Page has no linked Instagram professional account',
          false,
          emptyMetadata(),
        );
      const id = stringField(linked['id']);
      return {
        id: id!,
        username: stringField(linked['username']),
        // This edge is named instagram_business_account by Graph, so the
        // linked account is already the Business professional variant.
        accountType: 'BUSINESS',
      };
    }
    const result = await this.read('/me?fields=id,username,account_type');
    const id = stringField(result['id']);
    if (!id)
      throw new MetaIntegrationError(
        'AUTH',
        'Meta token did not identify an Instagram account',
        false,
        emptyMetadata(),
      );
    const rawType = stringField(result['account_type'])?.toUpperCase();
    return {
      id,
      username: stringField(result['username']),
      accountType: rawType === 'BUSINESS' || rawType === 'CREATOR' ? rawType : 'UNKNOWN',
    };
  }

  async verifyConfiguredAccountId(): Promise<boolean> {
    if (!this.config.instagramAccountId) return false;
    return (await this.getAuthenticatedInstagramAccount()).id === this.config.instagramAccountId;
  }

  async checkRequiredPermissions(): Promise<PermissionCheck[]> {
    const result = await this.read('/me/permissions');
    const entries = Array.isArray(result['data']) ? result['data'] : [];
    const granted = new Set(
      entries.flatMap((entry) => {
        if (!isRecord(entry) || stringField(entry['status']) !== 'granted') return [];
        const permission = stringField(entry['permission']);
        return permission ? [permission] : [];
      }),
    );
    if (!entries.length)
      return this.requiredPermissions().map((permission) => ({ permission, state: 'UNKNOWN' }));
    return this.requiredPermissions().map((permission) => ({
      permission,
      state: granted.has(permission) ? 'GRANTED' : 'MISSING',
    }));
  }

  checkTokenExpiry(): Promise<TokenExpiryCheck> {
    return Promise.resolve(this.expiryState(this.config.tokenExpiresAt ?? null));
  }

  async checkPublishingCapability(): Promise<InstagramPublishingCapability> {
    const initial = this.validateConfiguration();
    if (!initial.configured) return initial;
    const [account, permissions, tokenExpiry] = await Promise.all([
      this.validateToken(),
      this.checkRequiredPermissions(),
      this.checkTokenExpiry(),
    ]);
    const configuredAccountMatches = account.id === this.config.instagramAccountId;
    const contentPublish = permissions.find(
      (entry) =>
        entry.permission ===
        (this.isFacebookLogin()
          ? 'instagram_content_publish'
          : 'instagram_business_content_publish'),
    );
    return {
      ...initial,
      authenticated: true,
      accountAccessible: true,
      account,
      configuredAccountMatches,
      permissions,
      tokenExpiry,
      publishingPermission:
        configuredAccountMatches && account.accountType !== 'UNKNOWN'
          ? contentPublish?.state === 'GRANTED'
            ? true
            : contentPublish?.state === 'MISSING'
              ? false
              : null
          : false,
    };
  }

  async checkPublishingLimit(): Promise<PublishingLimitStatus> {
    if (!this.validateConfiguration().configured)
      return { supported: null, allowed: null, quotaUsage: null, quotaTotal: null };
    try {
      const result = await this.read(`/${this.config.instagramAccountId}/content_publishing_limit`);
      const first =
        Array.isArray(result['data']) && isRecord(result['data'][0]) ? result['data'][0] : null;
      const quotaUsage = typeof first?.['quota_usage'] === 'number' ? first['quota_usage'] : null;
      const quotaTotal = typeof first?.['config'] === 'number' ? first['config'] : null;
      return {
        supported: Boolean(first),
        allowed: quotaUsage !== null && quotaTotal !== null ? quotaUsage < quotaTotal : null,
        quotaUsage,
        quotaTotal,
      };
    } catch (error) {
      if (error instanceof MetaIntegrationError && error.code === 'FEATURE_UNSUPPORTED')
        return { supported: false, allowed: null, quotaUsage: null, quotaTotal: null };
      throw error;
    }
  }

  async createReelContainer(input: ReelContainerInput): Promise<{ containerId: string }> {
    this.assertPublishingEnabled();
    const result = await this.write(`/${this.config.instagramAccountId}/media`, {
      media_type: 'REELS',
      video_url: input.videoUrl,
      caption: input.caption,
      ...(input.shareToFeed !== undefined ? { share_to_feed: String(input.shareToFeed) } : {}),
      ...(input.coverUrl ? { cover_url: input.coverUrl } : {}),
    });
    const containerId = stringField(result['id']);
    if (!containerId)
      throw new MetaIntegrationError(
        'UNKNOWN_PROVIDER_ERROR',
        'Meta did not return a Reel container ID',
        false,
        emptyMetadata(),
      );
    return { containerId };
  }

  async getContainerStatus(containerId: string): Promise<ReelContainerStatus> {
    const result = await this.read(`/${containerId}?fields=status_code,status`);
    const status = stringField(result['status_code']) ?? 'UNKNOWN';
    return {
      containerId,
      status: ['IN_PROGRESS', 'FINISHED', 'ERROR', 'EXPIRED', 'PUBLISHED'].includes(status)
        ? (status as ReelContainerStatus['status'])
        : 'UNKNOWN',
      ...(stringField(result['status']) ? { errorMessage: stringField(result['status'])! } : {}),
    };
  }

  async publishContainer(containerId: string): Promise<{ mediaId: string }> {
    this.assertPublishingEnabled();
    const result = await this.write(`/${this.config.instagramAccountId}/media_publish`, {
      creation_id: containerId,
    });
    const mediaId = stringField(result['id']);
    if (!mediaId)
      throw new MetaIntegrationError(
        'UNKNOWN_PROVIDER_ERROR',
        'Meta did not return published media ID',
        false,
        emptyMetadata(),
      );
    return { mediaId };
  }

  async getPublishedMedia(mediaId: string): Promise<PublishedInstagramMedia> {
    const result = await this.read(`/${mediaId}?fields=id,permalink`);
    const returnedMediaId = stringField(result['id']);
    if (!returnedMediaId)
      throw new MetaIntegrationError(
        'UNKNOWN_PROVIDER_ERROR',
        'Meta media lookup returned no media ID',
        false,
        emptyMetadata(),
      );
    return { mediaId: returnedMediaId, permalink: stringField(result['permalink']) };
  }

  async reconcilePublish(
    containerId: string,
    mediaId?: string,
  ): Promise<PublishedInstagramMedia | null> {
    if (mediaId) return this.getPublishedMedia(mediaId);
    await this.getContainerStatus(containerId);
    return null;
  }

  private expiryState(expiresAt: Date | null): TokenExpiryCheck {
    if (!expiresAt) return { state: 'UNKNOWN', expiresAt: null };
    const remaining = expiresAt.getTime() - Date.now();
    return {
      state:
        remaining <= 0
          ? 'EXPIRED'
          : remaining <= 7 * 24 * 60 * 60 * 1_000
            ? 'EXPIRING_SOON'
            : 'VALID',
      expiresAt,
    };
  }

  private isFacebookLogin(): boolean {
    return this.config.authPath === 'facebook_login';
  }

  private authPathLabel(): 'FACEBOOK_LOGIN' | 'INSTAGRAM_LOGIN' {
    return this.isFacebookLogin() ? 'FACEBOOK_LOGIN' : 'INSTAGRAM_LOGIN';
  }

  private requiredPermissions(): readonly MetaRequiredPermission[] {
    return this.isFacebookLogin()
      ? META_FACEBOOK_LOGIN_REQUIRED_PERMISSIONS
      : META_REQUIRED_PERMISSIONS;
  }

  private requiredPageId(): string {
    if (!this.config.pageId)
      throw new MetaIntegrationError(
        'AUTH',
        'Facebook Login requires a configured Page ID',
        false,
        emptyMetadata(),
      );
    return this.config.pageId;
  }

  private assertPublishingEnabled(): void {
    if (!this.config.publishingEnabled) throw new MetaPublishingDisabledError();
    if (!this.validateConfiguration().configured)
      throw new MetaIntegrationError(
        'AUTH',
        'Meta publishing is not configured',
        false,
        emptyMetadata(),
      );
  }

  private async read(path: string): Promise<MetaJson> {
    return this.requestJson(path, { method: 'GET' });
  }

  private async write(path: string, body: Record<string, string>): Promise<MetaJson> {
    return this.requestJson(path, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body),
    });
  }

  private async requestJson(path: string, init: RequestInit): Promise<MetaJson> {
    if (!this.config.accessToken)
      throw new MetaIntegrationError(
        'AUTH',
        'Meta access token is not configured',
        false,
        emptyMetadata(),
      );
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 15_000);
    try {
      const response = await this.request(
        `${this.isFacebookLogin() ? 'https://graph.facebook.com' : 'https://graph.instagram.com'}/${this.config.graphApiVersion}${path}`,
        {
          ...init,
          headers: { authorization: `Bearer ${this.config.accessToken}`, ...init.headers },
          signal: controller.signal,
        },
      );
      const body: unknown = await response.json().catch(() => ({}));
      if (!response.ok)
        throw classifyMetaError(response.status, body, response.headers.get('retry-after'));
      if (!isRecord(body))
        throw new MetaIntegrationError(
          'UNKNOWN_PROVIDER_ERROR',
          'Meta returned an invalid response',
          false,
          emptyMetadata(),
        );
      return body;
    } catch (error) {
      if (error instanceof MetaIntegrationError) throw error;
      if (controller.signal.aborted)
        throw new MetaIntegrationError('TIMEOUT', 'Meta request timed out', true, emptyMetadata());
      throw new MetaIntegrationError(
        'NETWORK',
        'Meta request could not be completed',
        true,
        emptyMetadata(),
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}
