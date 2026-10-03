import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const redirectUri = 'http://127.0.0.1:53682/';
const gmailScopes = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose',
].join(' ');

export function buildConsentUrl(clientId: string) {
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: gmailScopes,
    access_type: 'offline',
    prompt: 'consent',
  }).toString();
  return url.toString();
}

export function extractAuthorizationCode(value: string) {
  const input = value.trim();
  if (/^https?:\/\//i.test(input)) {
    const code = new URL(input).searchParams.get('code');
    if (!code) throw new Error('The redirect URL does not contain a code.');
    return code;
  }
  if (!input)
    throw new Error('An authorization code or redirect URL is required.');
  return input;
}

export function upsertEnvValue(contents: string, key: string, value: string) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
    throw new Error('Invalid environment variable name.');
  if (/[\r\n]/.test(value))
    throw new Error('Environment variable values cannot contain CR or LF.');
  const newline = contents.includes('\r\n') ? '\r\n' : '\n';
  const hadTrailingNewline = /(?:\r?\n)$/.test(contents);
  const lines = contents ? contents.split(/\r?\n/) : [];
  if (hadTrailingNewline) lines.pop();
  const assignment = new RegExp(`^\\s*${key}\\s*=`);
  let found = false;
  const updated = lines.map((line) => {
    if (!assignment.test(line)) return line;
    found = true;
    return `${key}=${value}`;
  });
  if (!found) updated.push(`${key}=${value}`);
  return `${updated.join(newline)}${hadTrailingNewline ? newline : ''}`;
}

async function main() {
  const [input] = process.argv.slice(2);
  if (process.argv.length > 3)
    throw new Error('Pass at most one authorization code or redirect URL.');
  const clientId = process.env.GMAIL_CLIENT_ID;
  if (!clientId) throw new Error('GMAIL_CLIENT_ID is required.');
  if (input === undefined) {
    console.log(buildConsentUrl(clientId));
    return;
  }
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;
  if (!clientSecret) throw new Error('GMAIL_CLIENT_SECRET is required.');
  const code = extractAuthorizationCode(input);
  const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  if (!tokenResponse.ok)
    throw new Error(
      `Google OAuth token exchange failed (HTTP ${tokenResponse.status}).`,
    );
  const tokens: unknown = await tokenResponse.json();
  if (
    !tokens ||
    typeof tokens !== 'object' ||
    !('access_token' in tokens) ||
    typeof tokens.access_token !== 'string' ||
    !tokens.access_token ||
    !('refresh_token' in tokens) ||
    typeof tokens.refresh_token !== 'string' ||
    !tokens.refresh_token
  )
    throw new Error('Google OAuth did not return the required tokens.');

  const profileResponse = await fetch(
    'https://gmail.googleapis.com/gmail/v1/users/me/profile',
    { headers: { Authorization: `Bearer ${tokens.access_token}` } },
  );
  if (!profileResponse.ok)
    throw new Error(
      `Gmail profile request failed (HTTP ${profileResponse.status}).`,
    );
  const profile: unknown = await profileResponse.json();
  if (
    !profile ||
    typeof profile !== 'object' ||
    !('emailAddress' in profile) ||
    typeof profile.emailAddress !== 'string' ||
    !profile.emailAddress
  )
    throw new Error('Gmail did not return an email address.');

  let envContents = '';
  try {
    envContents = await readFile('.env', 'utf8');
  } catch (error) {
    if (
      !error ||
      typeof error !== 'object' ||
      !('code' in error) ||
      error.code !== 'ENOENT'
    )
      throw error;
  }
  await writeFile(
    '.env',
    upsertEnvValue(envContents, 'GMAIL_REFRESH_TOKEN', tokens.refresh_token),
    { mode: 0o600 },
  );
  console.log(profile.emailAddress);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error: unknown) => {
    console.error(
      error instanceof Error ? error.message : 'Gmail setup failed.',
    );
    process.exitCode = 1;
  });
}
