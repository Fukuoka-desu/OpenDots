import { afterEach, expect, it, vi } from 'vitest';
import { GmailClient } from '../src/server/gmail.js';
import { GoogleAuth, sharedGoogleAuth } from '../src/server/google-auth.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

function credentials(refreshToken = 'test-refresh-token') {
  return {
    clientId: 'test-client-id',
    clientSecret: 'test-client-secret',
    refreshToken,
  };
}

function tokenResponse() {
  return Response.json({ access_token: 'test-access-token', expires_in: 3600 });
}

it('reuses GoogleAuth for matching client and refresh token credentials', () => {
  const config = credentials();
  const auth = sharedGoogleAuth(config);

  expect(sharedGoogleAuth({ ...config })).toBe(auth);
  expect(
    sharedGoogleAuth({ ...config, refreshToken: 'another-refresh-token' }),
  ).not.toBe(auth);
  expect(
    sharedGoogleAuth({ ...config, clientId: 'another-client-id' }),
  ).not.toBe(auth);
});

it('caches the Gmail profile address across clients sharing GoogleAuth', async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(tokenResponse())
    .mockResolvedValueOnce(
      Response.json({ emailAddress: 'owner@example.com' }),
    );
  vi.stubGlobal('fetch', fetcher);
  const auth = new GoogleAuth(credentials());
  const first = new GmailClient(auth);
  const second = new GmailClient(auth);

  await expect(
    Promise.all([first.emailAddress(), second.emailAddress()]),
  ).resolves.toEqual(['owner@example.com', 'owner@example.com']);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(String(fetcher.mock.calls[1]![0])).toBe(
    'https://gmail.googleapis.com/gmail/v1/users/me/profile',
  );
});

it('retries a rejected Gmail profile request on the next call', async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(tokenResponse())
    .mockResolvedValueOnce(
      Response.json(
        { error: { code: 503, message: 'temporarily unavailable' } },
        { status: 503 },
      ),
    )
    .mockResolvedValueOnce(
      Response.json({ emailAddress: 'owner@example.com' }),
    );
  vi.stubGlobal('fetch', fetcher);
  const client = new GmailClient(new GoogleAuth(credentials()));

  await expect(client.emailAddress()).rejects.toThrow(
    'Gmail API returned HTTP 503: temporarily unavailable',
  );
  await expect(client.emailAddress()).resolves.toBe('owner@example.com');
  expect(fetcher).toHaveBeenCalledTimes(3);
});
