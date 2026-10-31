import { chmod, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { google, type drive_v3, type sheets_v4 } from 'googleapis';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const localEnvPath = path.join(projectRoot, '.env.local');
const expectedAccount = 'khushchouhan9680@gmail.com';
const folderMimeType = 'application/vnd.google-apps.folder';
const spreadsheetMimeType = 'application/vnd.google-apps.spreadsheet';
const rootName = 'Instagram Reel Automation';
const spreadsheetName = 'Instagram Reel Automation Control';

const videoHeaders = [
  'Video ID',
  'Face ID',
  'Video Link',
  'Title',
  'Thumbnail Link',
  'Approval',
  'Status',
  'Selected Date',
  'Scheduled Date',
  'Scheduled Time',
  'Posted Date',
  'Instagram Media ID',
  'Instagram Permalink',
  'Caption',
  'Hashtags',
  'Error',
  'Retry Count',
  'Notes',
];
const approvalValues = ['PENDING', 'APPROVED', 'REJECTED', 'CHANGES_REQUIRED'];
const statusValues = [
  'WAITING_VIDEO',
  'WAITING_FACE',
  'WAITING_TITLE',
  'WAITING_THUMBNAIL',
  'WAITING_APPROVAL',
  'READY',
  'SELECTED',
  'CONTENT_GENERATING',
  'CONTENT_READY',
  'SCHEDULED',
  'PUBLISHING',
  'POSTED',
  'FAILED',
  'MANUAL_ACTION_REQUIRED',
  'SKIPPED',
];
const postingHeaders = [
  'Date',
  'Video ID',
  'Face ID',
  'Scheduled Time',
  'Posted Time',
  'Instagram Media ID',
  'Permalink',
  'Result',
];
const settings = [
  ['Timezone', 'Asia/Kolkata'],
  ['Daily Reel Limit', 2],
  ['Same Face Gap Days', 2],
  ['Slot 1', '19:00'],
  ['Slot 2', '20:00'],
  ['Automation', 'OFF'],
  ['Tag Account 1', ''],
  ['Tag Account 2', ''],
  ['Collaborator', ''],
];

async function loadLocalEnvFiles(): Promise<void> {
  for (const envPath of [path.join(projectRoot, '.env'), localEnvPath]) {
    let contents: string;
    try {
      contents = await readFile(envPath, 'utf8');
    } catch {
      continue;
    }
    for (const line of contents.split(/\r?\n/)) {
      const match = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (!match || process.env[match[1]!] !== undefined) continue;
      process.env[match[1]!] = match[2]!.replace(/^(['"])(.*)\1$/, '$2');
    }
  }
}

async function updateEnvValues(values: Record<string, string>): Promise<void> {
  let contents = '';
  try {
    contents = await readFile(localEnvPath, 'utf8');
  } catch {
    // The ignored local environment file will be created.
  }
  for (const [key, value] of Object.entries(values)) {
    const line = `${key}="${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
    const expression = new RegExp(`^${key}=.*$`, 'm');
    contents = expression.test(contents)
      ? contents.replace(expression, line)
      : `${contents}${contents && !contents.endsWith('\n') ? '\n' : ''}${line}\n`;
  }
  await writeFile(localEnvPath, contents, { encoding: 'utf8', mode: 0o600 });
  try {
    await chmod(localEnvPath, 0o600);
  } catch {
    // Windows ACLs are controlled by the current user profile.
  }
}

function escapeQueryValue(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll("'", "\\'");
}

async function findExactChild(
  drive: drive_v3.Drive,
  parentId: string,
  name: string,
  mimeType: string,
): Promise<{ id: string; reused: boolean; duplicateCount: number }> {
  const response = await drive.files.list({
    q: `'${escapeQueryValue(parentId)}' in parents and name = '${escapeQueryValue(name)}' and mimeType = '${mimeType}' and trashed = false`,
    orderBy: 'createdTime asc',
    pageSize: 100,
    spaces: 'drive',
    fields: 'files(id,name,mimeType,createdTime)',
  });
  const matches = (response.data.files ?? []).filter((file) => file.id);
  if (matches[0]?.id)
    return { id: matches[0].id, reused: true, duplicateCount: Math.max(0, matches.length - 1) };
  const created = await drive.files.create({
    requestBody: { name, mimeType, parents: [parentId] },
    fields: 'id',
  });
  if (!created.data.id) throw new Error(`Google Drive did not return an ID for ${name}`);
  return { id: created.data.id, reused: false, duplicateCount: 0 };
}

async function findOrCreateRoot(
  drive: drive_v3.Drive,
): Promise<{ id: string; reused: boolean; duplicateCount: number }> {
  return findExactChild(drive, 'root', rootName, folderMimeType);
}

async function ensureTabs(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  createdSpreadsheet: boolean,
): Promise<Map<string, sheets_v4.Schema$SheetProperties>> {
  const metadata = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: 'sheets(properties(sheetId,title,gridProperties(rowCount,columnCount,frozenRowCount)))',
  });
  const current = new Map(
    (metadata.data.sheets ?? []).flatMap((sheet) =>
      sheet.properties?.title ? [[sheet.properties.title, sheet.properties] as const] : [],
    ),
  );
  const requests: sheets_v4.Schema$Request[] = [];
  if (!current.has('Videos')) {
    const initial = createdSpreadsheet ? metadata.data.sheets?.[0]?.properties : undefined;
    if (initial?.sheetId != null) {
      requests.push({
        updateSheetProperties: {
          properties: { sheetId: initial.sheetId, title: 'Videos' },
          fields: 'title',
        },
      });
    } else requests.push({ addSheet: { properties: { title: 'Videos' } } });
  }
  for (const title of ['Settings', 'Posting History'])
    if (!current.has(title)) requests.push({ addSheet: { properties: { title } } });
  if (requests.length)
    await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });

  const refreshed = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: 'sheets(properties(sheetId,title,gridProperties(rowCount,columnCount,frozenRowCount)))',
  });
  return new Map(
    (refreshed.data.sheets ?? []).flatMap((sheet) =>
      sheet.properties?.title ? [[sheet.properties.title, sheet.properties] as const] : [],
    ),
  );
}

function requiredSheet(
  tabs: Map<string, sheets_v4.Schema$SheetProperties>,
  title: string,
): sheets_v4.Schema$SheetProperties & { sheetId: number } {
  const properties = tabs.get(title);
  if (!properties || properties.sheetId == null)
    throw new Error(`Required Sheet tab is missing: ${title}`);
  return properties as sheets_v4.Schema$SheetProperties & { sheetId: number };
}

async function configureSpreadsheet(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  createdSpreadsheet: boolean,
): Promise<string[]> {
  const tabs = await ensureTabs(sheets, spreadsheetId, createdSpreadsheet);
  const videos = requiredSheet(tabs, 'Videos');
  const settingsTab = requiredSheet(tabs, 'Settings');
  const posting = requiredSheet(tabs, 'Posting History');

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: 'RAW',
      data: [
        { range: 'Videos!A1:R1', values: [videoHeaders] },
        { range: 'Settings!A1:B9', values: settings },
        { range: "'Posting History'!A1:H1", values: [postingHeaders] },
      ],
    },
  });

  const headerFormat: sheets_v4.Schema$CellFormat = {
    backgroundColorStyle: { rgbColor: { red: 0.9, green: 0.92, blue: 0.95 } },
    textFormat: {
      bold: true,
      foregroundColorStyle: { rgbColor: { red: 0.1, green: 0.13, blue: 0.2 } },
    },
    verticalAlignment: 'MIDDLE',
    wrapStrategy: 'WRAP',
  };
  const requests: sheets_v4.Schema$Request[] = [
    ...[videos, posting].map((sheet) => ({
      updateSheetProperties: {
        properties: {
          sheetId: sheet.sheetId,
          gridProperties: {
            rowCount: Math.max(sheet.gridProperties?.rowCount ?? 0, 10_000),
            columnCount: Math.max(
              sheet.gridProperties?.columnCount ?? 0,
              sheet.sheetId === videos.sheetId ? 18 : 8,
            ),
            frozenRowCount: 1,
          },
        },
        fields: 'gridProperties(rowCount,columnCount,frozenRowCount)',
      },
    })),
    {
      repeatCell: {
        range: {
          sheetId: videos.sheetId,
          startRowIndex: 0,
          endRowIndex: 1,
          startColumnIndex: 0,
          endColumnIndex: 18,
        },
        cell: { userEnteredFormat: headerFormat },
        fields: 'userEnteredFormat(backgroundColorStyle,textFormat,verticalAlignment,wrapStrategy)',
      },
    },
    {
      repeatCell: {
        range: {
          sheetId: posting.sheetId,
          startRowIndex: 0,
          endRowIndex: 1,
          startColumnIndex: 0,
          endColumnIndex: 8,
        },
        cell: { userEnteredFormat: headerFormat },
        fields: 'userEnteredFormat(backgroundColorStyle,textFormat,verticalAlignment,wrapStrategy)',
      },
    },
    {
      repeatCell: {
        range: {
          sheetId: settingsTab.sheetId,
          startRowIndex: 0,
          endRowIndex: 9,
          startColumnIndex: 0,
          endColumnIndex: 1,
        },
        cell: {
          userEnteredFormat: {
            backgroundColorStyle: { rgbColor: { red: 0.95, green: 0.96, blue: 0.97 } },
            textFormat: { bold: true },
          },
        },
        fields: 'userEnteredFormat(backgroundColorStyle,textFormat)',
      },
    },
    {
      setDataValidation: {
        range: {
          sheetId: videos.sheetId,
          startRowIndex: 1,
          endRowIndex: 10_000,
          startColumnIndex: 5,
          endColumnIndex: 6,
        },
        rule: {
          condition: {
            type: 'ONE_OF_LIST',
            values: approvalValues.map((userEnteredValue) => ({ userEnteredValue })),
          },
          strict: true,
          showCustomUi: true,
        },
      },
    },
    {
      setDataValidation: {
        range: {
          sheetId: videos.sheetId,
          startRowIndex: 1,
          endRowIndex: 10_000,
          startColumnIndex: 6,
          endColumnIndex: 7,
        },
        rule: {
          condition: {
            type: 'ONE_OF_LIST',
            values: statusValues.map((userEnteredValue) => ({ userEnteredValue })),
          },
          strict: true,
          showCustomUi: true,
        },
      },
    },
    ...[
      { sheetId: videos.sheetId, endIndex: 18 },
      { sheetId: settingsTab.sheetId, endIndex: 2 },
      { sheetId: posting.sheetId, endIndex: 8 },
    ].map(({ sheetId, endIndex }) => ({
      autoResizeDimensions: {
        dimensions: { sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex },
      },
    })),
  ];
  await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });
  return [...tabs.keys()];
}

async function assertFolderAccess(drive: drive_v3.Drive, id: string, name: string): Promise<void> {
  const response = await drive.files.get({
    fileId: id,
    fields: 'id,name,mimeType,capabilities(canEdit,canAddChildren)',
  });
  if (
    response.data.name !== name ||
    response.data.mimeType !== folderMimeType ||
    !response.data.capabilities?.canEdit ||
    !response.data.capabilities.canAddChildren
  )
    throw new Error(`Authenticated account lacks read/write folder access: ${name}`);
}

async function main(): Promise<void> {
  await loadLocalEnvFiles();
  const clientId = process.env['GOOGLE_CLIENT_ID'];
  const clientSecret = process.env['GOOGLE_CLIENT_SECRET'];
  const refreshToken = process.env['GOOGLE_REFRESH_TOKEN'];
  if (!clientId || !clientSecret || !refreshToken)
    throw new Error('Google OAuth is not configured');
  const auth = new google.auth.OAuth2(clientId, clientSecret);
  auth.setCredentials({ refresh_token: refreshToken });
  const drive = google.drive({ version: 'v3', auth });
  const sheets = google.sheets({ version: 'v4', auth });

  const about = await drive.about.get({ fields: 'user(emailAddress)' });
  const account = about.data.user?.emailAddress?.toLowerCase();
  if (account !== expectedAccount)
    throw new Error(`Authenticated Google account mismatch: ${account ?? 'unknown'}`);

  const root = await findOrCreateRoot(drive);
  const videos = await findExactChild(drive, root.id, 'Videos', folderMimeType);
  const thumbnails = await findExactChild(drive, root.id, 'Thumbnails', folderMimeType);
  const archive = await findExactChild(drive, root.id, 'Archive', folderMimeType);
  const spreadsheet = await findExactChild(drive, root.id, spreadsheetName, spreadsheetMimeType);

  const tabs = await configureSpreadsheet(sheets, spreadsheet.id, !spreadsheet.reused);
  await Promise.all([
    assertFolderAccess(drive, root.id, rootName),
    assertFolderAccess(drive, videos.id, 'Videos'),
    assertFolderAccess(drive, thumbnails.id, 'Thumbnails'),
    assertFolderAccess(drive, archive.id, 'Archive'),
  ]);
  const sheetFile = await drive.files.get({
    fileId: spreadsheet.id,
    fields: 'id,name,mimeType,capabilities(canEdit)',
  });
  if (
    sheetFile.data.name !== spreadsheetName ||
    sheetFile.data.mimeType !== spreadsheetMimeType ||
    !sheetFile.data.capabilities?.canEdit
  )
    throw new Error('Authenticated account lacks read/write spreadsheet access');

  await updateEnvValues({
    GOOGLE_AUTOMATION_ROOT_FOLDER_ID: root.id,
    GOOGLE_VIDEO_FOLDER_ID: videos.id,
    GOOGLE_THUMBNAIL_FOLDER_ID: thumbnails.id,
    GOOGLE_ARCHIVE_FOLDER_ID: archive.id,
    GOOGLE_SHEET_ID: spreadsheet.id,
  });

  console.log(
    JSON.stringify({
      accountVerified: true,
      resources: {
        root: { reused: root.reused, duplicateCount: root.duplicateCount },
        videos: { reused: videos.reused, duplicateCount: videos.duplicateCount },
        thumbnails: { reused: thumbnails.reused, duplicateCount: thumbnails.duplicateCount },
        archive: { reused: archive.reused, duplicateCount: archive.duplicateCount },
        spreadsheet: { reused: spreadsheet.reused, duplicateCount: spreadsheet.duplicateCount },
      },
      requiredTabs: ['Videos', 'Settings', 'Posting History'].every((title) =>
        tabs.includes(title),
      ),
      unexpectedTabsPreserved: tabs.filter(
        (title) => !['Videos', 'Settings', 'Posting History'].includes(title),
      ),
      environmentUpdated: true,
      driveReadWriteVerified: true,
      sheetsReadWriteVerified: true,
      automation: 'OFF',
    }),
  );
}

await main().catch((error: unknown) => {
  console.error(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
});
