import { google, type drive_v3, type sheets_v4, type Auth } from 'googleapis';
import { z } from 'zod';
import type {
  DriveVideoAsset,
  GoogleDriveAdapter,
  GoogleSheetsAdapter,
  SheetVideoRow,
} from './index.js';

export type GoogleFailureCode =
  'AUTH' | 'RATE_LIMIT' | 'TRANSIENT' | 'PERMISSION' | 'NOT_FOUND' | 'VALIDATION' | 'PERMANENT';

export class GoogleIntegrationError extends Error {
  constructor(
    readonly code: GoogleFailureCode,
    message: string,
    readonly status?: number,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'GoogleIntegrationError';
  }
}

const googleCredentialSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('oauth'),
    clientId: z.string().min(1),
    clientSecret: z.string().min(1),
    refreshToken: z.string().min(1),
  }),
  z.object({ type: z.literal('service_account'), json: z.string().min(1) }),
]);
export type GoogleCredentialConfig = z.infer<typeof googleCredentialSchema>;

/** Construct auth without ever logging credential fields or token responses. */
export function createGoogleAuth(config: GoogleCredentialConfig): Auth.OAuth2Client | Auth.JWT {
  const parsed = googleCredentialSchema.parse(config);
  if (parsed.type === 'oauth') {
    const auth = new google.auth.OAuth2(parsed.clientId, parsed.clientSecret);
    auth.setCredentials({ refresh_token: parsed.refreshToken });
    return auth;
  }
  let account: unknown;
  try {
    account = JSON.parse(parsed.json) as unknown;
  } catch {
    throw new GoogleIntegrationError('VALIDATION', 'Google service account JSON is invalid');
  }
  const serviceAccountSchema = z.object({
    client_email: z.string().email(),
    private_key: z.string().min(1),
  });
  const credentials = serviceAccountSchema.safeParse(account);
  if (!credentials.success)
    throw new GoogleIntegrationError(
      'VALIDATION',
      'Google service account JSON is missing required fields',
    );
  return new google.auth.JWT({
    email: credentials.data.client_email,
    key: credentials.data.private_key,
    scopes: [
      // Upload and reconciliation require write access to existing configured folders.
      'https://www.googleapis.com/auth/drive',
      'https://www.googleapis.com/auth/spreadsheets',
    ],
  });
}

export const googleEnvironmentSchema = z.object({
  GOOGLE_AUTH_TYPE: z.enum(['oauth', 'service_account']).optional(),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_REFRESH_TOKEN: z.string().optional(),
  GOOGLE_OAUTH_CLIENT_ID: z.string().optional(),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().optional(),
  GOOGLE_OAUTH_REFRESH_TOKEN: z.string().optional(),
  GOOGLE_SERVICE_ACCOUNT_JSON: z.string().optional(),
  GOOGLE_SHEET_ID: z.string().optional(),
  GOOGLE_VIDEO_FOLDER_ID: z.string().optional(),
  GOOGLE_THUMBNAIL_FOLDER_ID: z.string().optional(),
  GOOGLE_ARCHIVE_FOLDER_ID: z.string().optional(),
  GOOGLE_DRIVE_FOLDER_ID: z.string().optional(),
  GOOGLE_SHEETS_SPREADSHEET_ID: z.string().optional(),
  GOOGLE_DRIVE_ARCHIVE_ENABLED: z.enum(['true', 'false']).default('false'),
});

export function googleCredentialConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): GoogleCredentialConfig {
  const parsed = googleEnvironmentSchema.parse(env);
  const authType =
    parsed.GOOGLE_AUTH_TYPE ?? (parsed.GOOGLE_SERVICE_ACCOUNT_JSON ? 'service_account' : 'oauth');
  const credentials =
    authType === 'oauth'
      ? {
          type: 'oauth' as const,
          clientId: parsed.GOOGLE_CLIENT_ID ?? parsed.GOOGLE_OAUTH_CLIENT_ID,
          clientSecret: parsed.GOOGLE_CLIENT_SECRET ?? parsed.GOOGLE_OAUTH_CLIENT_SECRET,
          refreshToken: parsed.GOOGLE_REFRESH_TOKEN ?? parsed.GOOGLE_OAUTH_REFRESH_TOKEN,
        }
      : { type: 'service_account' as const, json: parsed.GOOGLE_SERVICE_ACCOUNT_JSON };
  const result = googleCredentialSchema.safeParse(credentials);
  if (!result.success)
    throw new GoogleIntegrationError(
      'VALIDATION',
      'Google credentials are incomplete for the selected auth type',
    );
  return result.data;
}

export function getGoogleAuthStatus(env: NodeJS.ProcessEnv = process.env): {
  configured: boolean;
  authType: 'oauth' | 'service_account' | null;
} {
  const parsed = googleEnvironmentSchema.safeParse(env);
  if (!parsed.success) return { configured: false, authType: null };
  const values = parsed.data;
  const authType =
    values.GOOGLE_AUTH_TYPE ?? (values.GOOGLE_SERVICE_ACCOUNT_JSON ? 'service_account' : 'oauth');
  const configured =
    authType === 'oauth'
      ? Boolean(
          (values.GOOGLE_CLIENT_ID ?? values.GOOGLE_OAUTH_CLIENT_ID) &&
          (values.GOOGLE_CLIENT_SECRET ?? values.GOOGLE_OAUTH_CLIENT_SECRET) &&
          (values.GOOGLE_REFRESH_TOKEN ?? values.GOOGLE_OAUTH_REFRESH_TOKEN),
        )
      : Boolean(values.GOOGLE_SERVICE_ACCOUNT_JSON);
  return { configured, authType: configured ? authType : null };
}

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  random?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

function statusFrom(error: unknown): { status?: number; reason?: string } {
  if (typeof error !== 'object' || error === null) return {};
  const e = error as {
    code?: unknown;
    response?: { status?: unknown; data?: { error?: { errors?: Array<{ reason?: string }> } } };
  };
  const statusValue = e.response?.status ?? e.code;
  const status =
    typeof statusValue === 'number'
      ? statusValue
      : typeof statusValue === 'string' && /^\d+$/.test(statusValue)
        ? Number(statusValue)
        : undefined;
  const reason = e.response?.data?.error?.errors?.[0]?.reason;
  return { ...(status === undefined ? {} : { status }), ...(reason ? { reason } : {}) };
}

export function classifyGoogleError(error: unknown): GoogleIntegrationError {
  if (error instanceof GoogleIntegrationError) return error;
  const { status, reason } = statusFrom(error);
  if (status === 401)
    return new GoogleIntegrationError('AUTH', 'Google authorization failed', status);
  if (status === 403 && (reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded'))
    return new GoogleIntegrationError('RATE_LIMIT', 'Google rate limit reached', status, true);
  if (status === 403)
    return new GoogleIntegrationError('PERMISSION', 'Google access was denied', status);
  if (status === 404)
    return new GoogleIntegrationError('NOT_FOUND', 'Google resource was not found', status);
  if (status === 429)
    return new GoogleIntegrationError('RATE_LIMIT', 'Google rate limit reached', status, true);
  if (status !== undefined && status >= 500)
    return new GoogleIntegrationError(
      'TRANSIENT',
      'Google service temporarily failed',
      status,
      true,
    );
  if (status === 400)
    return new GoogleIntegrationError(
      'VALIDATION',
      'Google rejected the request parameters',
      status,
    );
  if (status !== undefined)
    return new GoogleIntegrationError('PERMANENT', 'Google request failed', status);
  return new GoogleIntegrationError(
    'TRANSIENT',
    'Google request failed temporarily',
    undefined,
    true,
  );
}

export async function withGoogleRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 4;
  const baseDelay = options.baseDelayMs ?? 250;
  const maxDelay = options.maxDelayMs ?? 5_000;
  const random = options.random ?? Math.random;
  const sleep =
    options.sleep ??
    ((milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (cause) {
      const error = classifyGoogleError(cause);
      if (!error.retryable || attempt >= maxAttempts) throw error;
      const ceiling = Math.min(maxDelay, baseDelay * 2 ** (attempt - 1));
      await sleep(Math.floor(Math.max(0, Math.min(1, random())) * ceiling));
    }
  }
}

export type GoogleDriveClient = Pick<drive_v3.Drive, 'files' | 'changes'>;
export type GoogleSheetsClient = Pick<sheets_v4.Sheets, 'spreadsheets'>;
export interface GoogleDriveFile {
  fileId: string;
  name: string;
  mimeType: string;
  size?: number;
  createdTime?: string;
  modifiedTime?: string;
  webViewLink?: string;
  checksum?: string;
  parents?: string[];
}
export interface DriveChangePage {
  changes: GoogleDriveFile[];
  nextPageToken?: string;
  newStartPageToken?: string;
}

export class GoogleDriveV3Adapter implements GoogleDriveAdapter {
  constructor(
    private readonly client: GoogleDriveClient = createGoogleDriveClientFromEnv(),
    private readonly retry: RetryOptions = {},
    private readonly archiveEnabled = false,
  ) {}

  async listFolderFiles(folderId: string): Promise<GoogleDriveFile[]> {
    if (!/^[A-Za-z0-9_-]+$/.test(folderId))
      throw new GoogleIntegrationError('VALIDATION', 'Drive folder ID is required');
    const files: GoogleDriveFile[] = [];
    let pageToken: string | undefined;
    do {
      const response = await withGoogleRetry(
        () =>
          this.client.files.list({
            q: `'${folderId.replaceAll("'", "\\'")}' in parents and trashed = false`,
            pageSize: 1000,
            ...(pageToken ? { pageToken } : {}),
            fields:
              'nextPageToken,files(id,name,mimeType,size,createdTime,webViewLink,md5Checksum,modifiedTime,parents)',
            includeItemsFromAllDrives: true,
            supportsAllDrives: true,
          }),
        this.retry,
      );
      for (const file of response.data.files ?? [])
        if (file.id && file.name && file.mimeType)
          files.push({
            fileId: file.id,
            name: file.name,
            mimeType: file.mimeType,
            ...(file.webViewLink ? { webViewLink: file.webViewLink } : {}),
            ...(file.size != null && Number.isFinite(Number(file.size))
              ? { size: Number(file.size) }
              : {}),
            ...(file.createdTime ? { createdTime: file.createdTime } : {}),
            ...(file.md5Checksum ? { checksum: file.md5Checksum } : {}),
            ...(file.modifiedTime ? { modifiedTime: file.modifiedTime } : {}),
            ...(file.parents ? { parents: file.parents } : {}),
          });
      pageToken = response.data.nextPageToken ?? undefined;
    } while (pageToken);
    return files;
  }

  async listVideoAssets(folderId: string): Promise<DriveVideoAsset[]> {
    return (await this.listFolderFiles(folderId))
      .filter((file) => file.mimeType.startsWith('video/'))
      .map(
        ({ fileId, name, mimeType, size, createdTime, modifiedTime, webViewLink, checksum }) => ({
          fileId,
          name,
          mimeType,
          ...(size !== undefined ? { size } : {}),
          ...(createdTime ? { createdTime } : {}),
          ...(modifiedTime ? { modifiedTime } : {}),
          ...(webViewLink ? { webViewLink } : {}),
          ...(checksum ? { checksum } : {}),
        }),
      );
  }

  async getDownloadUrl(fileId: string): Promise<string | null> {
    if (!fileId.trim()) throw new GoogleIntegrationError('VALIDATION', 'Drive file ID is required');
    const result = await withGoogleRetry(
      () => this.client.files.get({ fileId, fields: 'id,webContentLink', supportsAllDrives: true }),
      this.retry,
    );
    return result.data.webContentLink ?? null;
  }

  async getStartPageToken(): Promise<string> {
    const result = await withGoogleRetry(
      () => this.client.changes.getStartPageToken({ supportsAllDrives: true }),
      this.retry,
    );
    if (!result.data.startPageToken)
      throw new GoogleIntegrationError('PERMANENT', 'Google Drive returned no changes cursor');
    return result.data.startPageToken;
  }

  async listChanges(pageToken: string, driveId?: string): Promise<DriveChangePage> {
    if (!pageToken.trim())
      throw new GoogleIntegrationError('VALIDATION', 'Drive changes cursor is required');
    const result = await withGoogleRetry(
      () =>
        this.client.changes.list({
          pageToken,
          ...(driveId ? { driveId } : {}),
          includeItemsFromAllDrives: true,
          supportsAllDrives: true,
          fields:
            'nextPageToken,newStartPageToken,changes(fileId,removed,file(id,name,mimeType,size,createdTime,webViewLink,md5Checksum,modifiedTime,parents))',
        }),
      this.retry,
    );
    const changes = (result.data.changes ?? []).flatMap((change) => {
      const file = change.file;
      if (change.removed || !file?.id || !file.name || !file.mimeType) return [];
      return [
        {
          fileId: file.id,
          name: file.name,
          mimeType: file.mimeType,
          ...(file.size != null && Number.isFinite(Number(file.size))
            ? { size: Number(file.size) }
            : {}),
          ...(file.createdTime ? { createdTime: file.createdTime } : {}),
          ...(file.webViewLink ? { webViewLink: file.webViewLink } : {}),
          ...(file.md5Checksum ? { checksum: file.md5Checksum } : {}),
          ...(file.modifiedTime ? { modifiedTime: file.modifiedTime } : {}),
          ...(file.parents ? { parents: file.parents } : {}),
        },
      ];
    });
    return {
      changes,
      ...(result.data.nextPageToken ? { nextPageToken: result.data.nextPageToken } : {}),
      ...(result.data.newStartPageToken
        ? { newStartPageToken: result.data.newStartPageToken }
        : {}),
    };
  }

  async moveFileToArchive(fileId: string, archiveFolderId: string): Promise<void> {
    if (!this.archiveEnabled)
      throw new GoogleIntegrationError('PERMANENT', 'Drive archive moves are disabled');
    if (!fileId.trim() || !archiveFolderId.trim())
      throw new GoogleIntegrationError(
        'VALIDATION',
        'Drive file and archive folder IDs are required',
      );
    const info = await withGoogleRetry(
      () => this.client.files.get({ fileId, fields: 'parents', supportsAllDrives: true }),
      this.retry,
    );
    await withGoogleRetry(
      () =>
        this.client.files.update({
          fileId,
          addParents: archiveFolderId,
          removeParents: (info.data.parents ?? []).join(','),
          supportsAllDrives: true,
          fields: 'id,parents',
        }),
      this.retry,
    );
  }
}

export interface SheetPostingHistoryRow {
  date: string;
  videoId: string;
  faceId?: string;
  scheduledTime?: string;
  postedTime: string;
  instagramMediaId?: string;
  permalink?: string;
  result?: string;
}

/**
 * Extract the stable Drive file identity from the normal share-link shapes.
 * Sheet row numbers and display URLs are not workflow identities; this helper
 * is used only to connect a newly entered human row with a Drive-discovered
 * Video that already owns a permanent GCS identifier.
 */
export function googleDriveFileIdFromLink(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (/^[A-Za-z0-9_-]{10,}$/.test(trimmed)) return trimmed;
  try {
    const url = new URL(trimmed);
    if (!(url.hostname === 'drive.google.com' || url.hostname.endsWith('.google.com')))
      return undefined;
    const queryId = url.searchParams.get('id')?.trim();
    if (queryId && /^[A-Za-z0-9_-]{10,}$/.test(queryId)) return queryId;
    const segments = url.pathname.split('/').filter(Boolean);
    const marker = segments.indexOf('d');
    const pathId = marker >= 0 ? segments[marker + 1] : undefined;
    return pathId && /^[A-Za-z0-9_-]{10,}$/.test(pathId) ? pathId : undefined;
  } catch {
    return undefined;
  }
}
const MAX_SHEET_ROWS = 10_000;
const MAX_SHEET_COLUMNS = 100;
function assertBoundedA1Range(range: string): void {
  const match = /^([^!]+)!\$?([A-Z]{1,3})\$?(\d+):\$?([A-Z]{1,3})\$?(\d+)$/.exec(range);
  if (!match)
    throw new GoogleIntegrationError(
      'VALIDATION',
      'Sheet range must be an explicit bounded A1 range',
    );
  const columnNumber = (letters: string): number =>
    [...letters].reduce((sum, char) => sum * 26 + char.charCodeAt(0) - 64, 0);
  const rows = Number(match[5]) - Number(match[3]) + 1;
  const columns = columnNumber(match[4]!) - columnNumber(match[2]!) + 1;
  if (rows < 1 || columns < 1 || rows > MAX_SHEET_ROWS || columns > MAX_SHEET_COLUMNS)
    throw new GoogleIntegrationError('VALIDATION', 'Sheet range exceeds configured read bounds');
}

export class GoogleSheetsV4Adapter implements GoogleSheetsAdapter {
  constructor(
    private readonly client: GoogleSheetsClient = createGoogleSheetsClientFromEnv(),
    private readonly retry: RetryOptions = {},
  ) {}

  async getMetadata(spreadsheetId: string): Promise<{
    spreadsheetId: string;
    title?: string;
    sheets: Array<{ sheetId: number; title: string }>;
  }> {
    const response = await withGoogleRetry(
      () =>
        this.client.spreadsheets.get({
          spreadsheetId,
          fields: 'spreadsheetId,properties(title),sheets(properties(sheetId,title))',
        }),
      this.retry,
    );
    const title = response.data.properties?.title;
    return {
      spreadsheetId: response.data.spreadsheetId ?? spreadsheetId,
      ...(title ? { title } : {}),
      sheets: (response.data.sheets ?? []).flatMap((sheet) =>
        sheet.properties?.sheetId == null || !sheet.properties.title
          ? []
          : [{ sheetId: sheet.properties.sheetId, title: sheet.properties.title }],
      ),
    };
  }

  async readRange(spreadsheetId: string, range: string): Promise<unknown[][]> {
    assertBoundedA1Range(range);
    const result = await withGoogleRetry(
      () => this.client.spreadsheets.values.get({ spreadsheetId, range, majorDimension: 'ROWS' }),
      this.retry,
    );
    return (result.data.values ?? []).map((row): unknown[] =>
      Array.isArray(row) ? (row as unknown[]) : [],
    );
  }

  async readSettings(spreadsheetId: string, range = 'Settings!A1:B100'): Promise<unknown[][]> {
    return this.readRange(spreadsheetId, range);
  }

  async writeValues(spreadsheetId: string, range: string, values: unknown[][]): Promise<void> {
    assertBoundedA1Range(range);
    await withGoogleRetry(
      () =>
        this.client.spreadsheets.values.batchUpdate({
          spreadsheetId,
          requestBody: { valueInputOption: 'RAW', data: [{ range, values }] },
        }),
      this.retry,
    );
  }

  async readVideoRows(spreadsheetId: string, range: string): Promise<SheetVideoRow[]> {
    const values = await this.readRange(spreadsheetId, range);
    return values.slice(1).flatMap((row) => {
      const videoId = typeof row[0] === 'string' ? row[0].trim() : '';
      const hasRowData = row.some((value) => typeof value === 'string' && value.trim());
      if (!videoId && !hasRowData) return [];
      const optionalString = (value: unknown): string | undefined =>
        typeof value === 'string' && value.trim() ? value.trim() : undefined;
      const faceId = optionalString(row[1]);
      const videoLink = optionalString(row[2]);
      const title = optionalString(row[3]);
      const thumbnailLink = optionalString(row[4]);
      const approvalStatus = optionalString(row[5]);
      const status = optionalString(row[6]);
      const selectedDate = optionalString(row[7]);
      const scheduledDate = optionalString(row[8]);
      const scheduledTime = optionalString(row[9]);
      const postedDate = optionalString(row[10]);
      const instagramMediaId = optionalString(row[11]);
      const instagramPermalink = optionalString(row[12]);
      const caption = optionalString(row[13]);
      const hashtags = optionalString(row[14]);
      const error = optionalString(row[15]);
      const retryCount = typeof row[16] === 'number' ? row[16] : Number(row[16]);
      const notes = optionalString(row[17]);
      return [
        {
          videoId,
          ...(faceId ? { faceId } : {}),
          ...(videoLink ? { videoLink } : {}),
          ...(title ? { title } : {}),
          ...(thumbnailLink ? { thumbnailLink } : {}),
          ...(approvalStatus ? { approvalStatus } : {}),
          ...(status ? { status } : {}),
          ...(selectedDate ? { selectedDate } : {}),
          ...(scheduledDate ? { scheduledDate } : {}),
          ...(scheduledTime ? { scheduledTime } : {}),
          ...(postedDate ? { postedDate } : {}),
          ...(instagramMediaId ? { instagramMediaId } : {}),
          ...(instagramPermalink ? { instagramPermalink } : {}),
          ...(caption ? { caption } : {}),
          ...(hashtags ? { hashtags } : {}),
          ...(error ? { error } : {}),
          ...(Number.isInteger(retryCount) && retryCount >= 0 ? { retryCount } : {}),
          ...(notes ? { notes } : {}),
        },
      ];
    });
  }

  async mirrorVideoRows(spreadsheetId: string, rows: SheetVideoRow[]): Promise<void> {
    // Include the source link so a newly entered human row with no GCS ID can
    // be repaired in place after Drive discovery, rather than appended as a
    // second logical row.
    const ids = await this.readRange(spreadsheetId, 'Videos!A2:C10001');
    const sheetRowByVideoId = new Map<string, number>();
    const sheetRowByDriveFileId = new Map<string, number>();
    ids.forEach((row, index) => {
      const videoId = typeof row[0] === 'string' ? row[0].trim() : '';
      if (videoId && !sheetRowByVideoId.has(videoId)) sheetRowByVideoId.set(videoId, index + 2);
      const driveFileId =
        typeof row[2] === 'string' ? googleDriveFileIdFromLink(row[2]) : undefined;
      if (driveFileId && !sheetRowByDriveFileId.has(driveFileId))
        sheetRowByDriveFileId.set(driveFileId, index + 2);
    });
    let nextAppendRow = ids.length + 2;
    const data = rows.flatMap((row) => {
      const hasVideoIdOnSheet = sheetRowByVideoId.has(row.videoId);
      const existingRow =
        sheetRowByVideoId.get(row.videoId) ??
        (row.videoLink
          ? sheetRowByDriveFileId.get(googleDriveFileIdFromLink(row.videoLink) ?? '')
          : undefined);
      const sheetRow = existingRow ?? nextAppendRow++;
      const managedValues = [
        [
          row.status ?? '',
          row.selectedDate ?? '',
          row.scheduledDate ?? '',
          row.scheduledTime ?? '',
          row.postedDate ?? '',
          row.instagramMediaId ?? '',
          row.instagramPermalink ?? '',
          row.caption ?? '',
          row.hashtags ?? '',
          row.error ?? '',
          row.retryCount ?? '',
          row.notes ?? '',
        ],
      ];
      return [
        ...(hasVideoIdOnSheet
          ? []
          : [{ range: `Videos!A${sheetRow}:A${sheetRow}`, values: [[row.videoId]] }]),
        { range: `Videos!C${sheetRow}:C${sheetRow}`, values: [[row.videoLink ?? '']] },
        { range: `Videos!E${sheetRow}:E${sheetRow}`, values: [[row.thumbnailLink ?? '']] },
        { range: `Videos!F${sheetRow}:F${sheetRow}`, values: [[row.approvalStatus ?? '']] },
        { range: `Videos!G${sheetRow}:Q${sheetRow}`, values: [managedValues[0]!.slice(0, 11)] },
      ];
    });
    if (data.length === 0) return;
    await withGoogleRetry(
      () =>
        this.client.spreadsheets.values.batchUpdate({
          spreadsheetId,
          requestBody: { valueInputOption: 'RAW', data },
        }),
      this.retry,
    );
  }

  async mirrorPostingHistory(spreadsheetId: string, rows: SheetPostingHistoryRow[]): Promise<void> {
    const existing = await this.readRange(spreadsheetId, 'Posting History!B2:B10001');
    const sheetRowByVideoId = new Map<string, number>();
    existing.forEach((row, index) => {
      const videoId = typeof row[0] === 'string' ? row[0].trim() : '';
      if (videoId && !sheetRowByVideoId.has(videoId)) sheetRowByVideoId.set(videoId, index + 2);
    });
    let nextAppendRow = existing.length + 2;
    const byVideoId = new Map(rows.map((row) => [row.videoId, row]));
    const data = [...byVideoId.values()].map((row) => {
      const sheetRow = sheetRowByVideoId.get(row.videoId) ?? nextAppendRow++;
      return {
        range: `Posting History!A${sheetRow}:H${sheetRow}`,
        values: [
          [
            row.date,
            row.videoId,
            row.faceId ?? '',
            row.scheduledTime ?? '',
            row.postedTime,
            row.instagramMediaId ?? '',
            row.permalink ?? '',
            row.result ?? 'POSTED',
          ],
        ],
      };
    });
    if (data.length === 0) return;
    await withGoogleRetry(
      () =>
        this.client.spreadsheets.values.batchUpdate({
          spreadsheetId,
          requestBody: { valueInputOption: 'RAW', data },
        }),
      this.retry,
    );
  }
}

function createGoogleAuthFromEnv(): Auth.OAuth2Client | Auth.JWT {
  return createGoogleAuth(googleCredentialConfigFromEnv());
}

export function createGoogleDriveClientFromEnv(): GoogleDriveClient {
  return google.drive({ version: 'v3', auth: createGoogleAuthFromEnv() });
}

export function createGoogleSheetsClientFromEnv(): GoogleSheetsClient {
  return google.sheets({ version: 'v4', auth: createGoogleAuthFromEnv() });
}
