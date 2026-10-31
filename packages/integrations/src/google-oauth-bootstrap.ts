import { randomUUID } from 'node:crypto';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { google } from 'googleapis';

const callbackPath = '/oauth2callback';
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const redirectUri =
  process.env['GOOGLE_OAUTH_REDIRECT_URI'] ?? 'http://127.0.0.1:53682/oauth2callback';
const accountHint = process.env['GOOGLE_ACCOUNT_HINT'] ?? 'khushchouhan9680@gmail.com';
const scopes = [
  // The Phase 2 workflow uploads controlled media into existing configured folders.
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/spreadsheets',
];

async function loadLocalEnvFiles(): Promise<void> {
  for (const envPath of [path.join(projectRoot, '.env'), path.join(projectRoot, '.env.local')]) {
    let contents: string;
    try {
      contents = await readFile(envPath, 'utf8');
    } catch {
      continue;
    }
    for (const line of contents.split(/\r?\n/)) {
      const match = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (!match || process.env[match[1]!] !== undefined) continue;
      const value = match[2]!.replace(/^(['"])(.*)\1$/, '$2');
      process.env[match[1]!] = value;
    }
  }
}

async function updateEnvFile(filePath: string, key: string, value: string): Promise<void> {
  let contents = '';
  try {
    contents = await readFile(filePath, 'utf8');
  } catch {
    /* create the local env file */
  }
  const escaped = value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
  const line = `${key}="${escaped}"`;
  const expression = new RegExp(`^${key}=.*$`, 'm');
  const updated = expression.test(contents)
    ? contents.replace(expression, line)
    : `${contents.trimEnd()}${contents.trim() ? '\n' : ''}${line}\n`;
  await writeFile(filePath, updated, { encoding: 'utf8', mode: 0o600 });
  await chmod(filePath, 0o600);
}

export async function bootstrapGoogleOAuth(): Promise<void> {
  await loadLocalEnvFiles();
  const clientId = process.env['GOOGLE_CLIENT_ID'] ?? process.env['GOOGLE_OAUTH_CLIENT_ID'];
  const clientSecret =
    process.env['GOOGLE_CLIENT_SECRET'] ?? process.env['GOOGLE_OAUTH_CLIENT_SECRET'];
  if (!clientId || !clientSecret)
    throw new Error(
      'Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env before starting OAuth setup.',
    );
  const redirect = new URL(redirectUri);
  if (
    redirect.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost'].includes(redirect.hostname) ||
    redirect.pathname !== callbackPath
  ) {
    throw new Error(
      'GOOGLE_OAUTH_REDIRECT_URI must be a localhost HTTP callback ending in /oauth2callback.',
    );
  }
  const auth = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  const state = randomUUID();
  const authorizationUrl = auth.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: true,
    login_hint: accountHint,
    scope: scopes,
    state,
  });
  console.log(
    `Open this Google authorization URL and approve access for ${accountHint}:\n${authorizationUrl}`,
  );
  console.log('Waiting for the localhost OAuth callback. No credential values will be printed.');

  const code = await new Promise<string>((resolve, reject) => {
    const server = createServer((request, response) => {
      const callback = new URL(request.url ?? '/', redirect.origin);
      if (callback.pathname !== callbackPath) {
        response.writeHead(404).end('Not found');
        return;
      }
      if (callback.searchParams.get('state') !== state) {
        response.writeHead(400).end('OAuth state mismatch');
        server.close();
        reject(new Error('OAuth callback state did not match.'));
        return;
      }
      const providerError = callback.searchParams.get('error');
      if (providerError) {
        response.writeHead(400).end('Google authorization was not completed.');
        server.close();
        reject(new Error(`Google authorization failed (${providerError}).`));
        return;
      }
      const authorizationCode = callback.searchParams.get('code');
      if (!authorizationCode) {
        response.writeHead(400).end('Missing authorization code');
        server.close();
        reject(new Error('Google callback did not include an authorization code.'));
        return;
      }
      response
        .writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
        .end('Google authorization complete. You can close this tab.');
      server.close(() => resolve(authorizationCode));
    });
    server.on('error', reject);
    server.listen(Number(redirect.port || 80), redirect.hostname);
    const timeout = setTimeout(() => {
      server.close();
      reject(new Error('OAuth callback timed out after five minutes.'));
    }, 5 * 60_000);
    server.on('close', () => clearTimeout(timeout));
  });

  const { tokens } = await auth.getToken(code);
  if (!tokens.refresh_token)
    throw new Error(
      'Google did not return a refresh token. Revoke the existing app grant, then rerun this helper with offline consent.',
    );
  const envPath = path.join(projectRoot, '.env.local');
  // Persist the complete OAuth client configuration together. A refresh token
  // cannot be exchanged later without the same client ID and client secret.
  await updateEnvFile(envPath, 'GOOGLE_CLIENT_ID', clientId);
  await updateEnvFile(envPath, 'GOOGLE_CLIENT_SECRET', clientSecret);
  await updateEnvFile(envPath, 'GOOGLE_REFRESH_TOKEN', tokens.refresh_token);
  console.log(
    `Google OAuth configured for ${accountHint}; OAuth values saved to ${path.basename(envPath)} (values hidden).`,
  );
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  bootstrapGoogleOAuth().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'OAuth setup failed.';
    console.error(message);
    process.exitCode = 1;
  });
}
