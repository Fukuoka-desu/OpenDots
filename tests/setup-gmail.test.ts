import { expect, it } from 'vitest';
import {
  buildConsentUrl,
  extractAuthorizationCode,
  upsertEnvValue,
} from '../scripts/setup-gmail.js';

it('builds the Gmail OAuth consent URL with offline Gmail and Calendar scopes', () => {
  const url = new URL(buildConsentUrl('desktop-client-id'));
  expect(url.origin + url.pathname).toBe(
    'https://accounts.google.com/o/oauth2/v2/auth',
  );
  expect(Object.fromEntries(url.searchParams)).toEqual({
    client_id: 'desktop-client-id',
    redirect_uri: 'http://127.0.0.1:53682/',
    response_type: 'code',
    scope:
      'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose https://www.googleapis.com/auth/calendar.events',
    access_type: 'offline',
    prompt: 'consent',
  });
});

it('extracts a code from a full redirect URL or accepts a raw code', () => {
  expect(
    extractAuthorizationCode(
      'http://127.0.0.1:53682/?code=authorization-code&scope=gmail.readonly',
    ),
  ).toBe('authorization-code');
  expect(extractAuthorizationCode('  raw-code  ')).toBe('raw-code');
});

it('replaces or appends GMAIL_REFRESH_TOKEN without changing other lines', () => {
  expect(
    upsertEnvValue(
      'OPENAI_MODEL=gpt-test\nGMAIL_REFRESH_TOKEN=old-token\n',
      'GMAIL_REFRESH_TOKEN',
      'new-token',
    ),
  ).toBe('OPENAI_MODEL=gpt-test\nGMAIL_REFRESH_TOKEN=new-token\n');
  expect(
    upsertEnvValue(
      'OPENAI_MODEL=gpt-test\n',
      'GMAIL_REFRESH_TOKEN',
      'new-token',
    ),
  ).toBe('OPENAI_MODEL=gpt-test\nGMAIL_REFRESH_TOKEN=new-token\n');
});
