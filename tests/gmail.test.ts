import { afterEach, expect, it, vi } from 'vitest';
import { GmailClient, gmailTools } from '../src/server/gmail.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function configuredClient() {
  return new GmailClient({
    clientId: 'test-client-id',
    clientSecret: 'test-client-secret',
    refreshToken: 'test-refresh-token',
  });
}

function tokenResponse() {
  return Response.json({ access_token: 'test-access-token', expires_in: 3600 });
}

function metadataMessage(id = 'message-1') {
  return Response.json({
    id,
    threadId: 'thread-1',
    snippet: 'A short preview',
    payload: {
      headers: [
        { name: 'From', value: 'sender@example.com' },
        { name: 'To', value: 'owner@example.com' },
        { name: 'Subject', value: 'Hello' },
        { name: 'Date', value: 'Mon, 01 Jan 2024 00:00:00 +0000' },
      ],
    },
  });
}

function findTool(tools: ReturnType<typeof gmailTools>, name: string) {
  const tool = tools.find((item) => item.name === name);
  if (!tool) throw new Error(`Missing tool: ${name}`);
  return tool;
}

function executeTool(
  tools: ReturnType<typeof gmailTools>,
  name: string,
  input: Record<string, unknown>,
) {
  const execute = findTool(tools, name).execute;
  if (!execute) throw new Error(`Tool cannot execute: ${name}`);
  return (
    execute as unknown as (input: Record<string, unknown>) => Promise<unknown>
  )(input);
}

it('refreshes the OAuth token once and caches it across searches', async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(tokenResponse())
    .mockResolvedValueOnce(Response.json({ messages: [{ id: 'message-1' }] }))
    .mockResolvedValueOnce(metadataMessage())
    .mockResolvedValueOnce(Response.json({ messages: [{ id: 'message-2' }] }))
    .mockResolvedValueOnce(metadataMessage('message-2'));
  vi.stubGlobal('fetch', fetcher);
  const client = configuredClient();

  const messages = await client.search('is:unread');
  expect(messages).toEqual([
    {
      id: 'message-1',
      threadId: 'thread-1',
      from: 'sender@example.com',
      to: 'owner@example.com',
      subject: 'Hello',
      date: 'Mon, 01 Jan 2024 00:00:00 +0000',
      snippet: 'A short preview',
    },
  ]);
  await client.search('newer_than:1d', 50);

  expect(fetcher).toHaveBeenCalledTimes(5);
  const [tokenUrl, tokenInit] = fetcher.mock.calls[0]!;
  expect(String(tokenUrl)).toBe('https://oauth2.googleapis.com/token');
  expect(
    Object.fromEntries(new URLSearchParams(String(tokenInit?.body))),
  ).toEqual({
    client_id: 'test-client-id',
    client_secret: 'test-client-secret',
    refresh_token: 'test-refresh-token',
    grant_type: 'refresh_token',
  });
  const [listUrl, listInit] = fetcher.mock.calls[1]!;
  expect(String(listUrl)).toContain('maxResults=10');
  expect(String(listUrl)).toContain('q=is%3Aunread');
  expect(new Headers(listInit?.headers).get('Authorization')).toBe(
    'Bearer test-access-token',
  );
  const [metadataUrl] = fetcher.mock.calls[2]!;
  const metadataParams = new URL(String(metadataUrl)).searchParams;
  expect(metadataParams.get('format')).toBe('metadata');
  expect(metadataParams.getAll('metadataHeaders')).toEqual([
    'From',
    'To',
    'Subject',
    'Date',
  ]);
  const [secondListUrl] = fetcher.mock.calls[3]!;
  expect(String(secondListUrl)).toContain('maxResults=20');
  expect(
    fetcher.mock.calls.filter(([url]) =>
      String(url).includes('oauth2.googleapis.com/token'),
    ),
  ).toHaveLength(1);
});

it('includes Gmail HTTP status and error.message without leaking the access token', async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(tokenResponse())
    .mockResolvedValueOnce(
      Response.json(
        { error: { message: 'Rejected test-access-token.' } },
        { status: 403 },
      ),
    );
  vi.stubGlobal('fetch', fetcher);
  const client = configuredClient();

  await expect(client.search('in:anywhere')).rejects.toThrow(
    'Gmail API returned HTTP 403: Rejected [redacted].',
  );
});

it('creates a UTF-8 draft with RFC 2047 subject, base64 body, and optional Cc', async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(tokenResponse())
    .mockResolvedValueOnce(Response.json({ id: 'draft-1' }));
  vi.stubGlobal('fetch', fetcher);
  const client = configuredClient();
  const japaneseBody = '日本語の本文です。'.repeat(8);

  await expect(
    client.createDraft({
      to: ['recipient@example.com'],
      cc: ['copy@example.com'],
      subject: 'こんにちは',
      body: japaneseBody,
    }),
  ).resolves.toEqual({
    draftId: 'draft-1',
    to: ['recipient@example.com'],
    cc: ['copy@example.com'],
    subject: 'こんにちは',
    body: japaneseBody,
  });

  const [url, init] = fetcher.mock.calls[1]!;
  expect(String(url)).toBe(
    'https://gmail.googleapis.com/gmail/v1/users/me/drafts',
  );
  expect(new Headers(init?.headers).get('Authorization')).toBe(
    'Bearer test-access-token',
  );
  const requestBody = JSON.parse(String(init?.body));
  const raw = Buffer.from(requestBody.message.raw, 'base64url').toString(
    'utf8',
  );
  expect(raw).toContain('To: recipient@example.com\r\n');
  expect(raw).toContain('Cc: copy@example.com\r\n');
  expect(raw).toContain(
    `Subject: =?UTF-8?B?${Buffer.from('こんにちは').toString('base64')}?=`,
  );
  expect(raw).toContain('Content-Type: text/plain; charset=UTF-8\r\n');
  expect(raw).toContain(
    Buffer.from(japaneseBody).toString('base64').slice(0, 76),
  );
  const bodyLines = raw.split('\r\n\r\n').at(-1)!.split('\r\n');
  expect(
    bodyLines.every(
      (line, index) =>
        line.length <= 76 &&
        (index === bodyLines.length - 1 || line.length === 76),
    ),
  ).toBe(true);
  expect(bodyLines.join('')).toBe(Buffer.from(japaneseBody).toString('base64'));
  expect(raw).not.toContain('From:');
});

it('rejects CRLF header injection before making any request', async () => {
  const fetcher = vi.fn<typeof fetch>();
  vi.stubGlobal('fetch', fetcher);
  const client = configuredClient();

  await expect(
    client.createDraft({
      to: ['recipient@example.com'],
      subject: 'Hello\r\nBcc: attacker@example.com',
      body: 'Text',
    }),
  ).rejects.toThrow('Email header values cannot contain CR or LF.');
  expect(fetcher).not.toHaveBeenCalled();
});

it('replies in the original thread with RFC reply headers and a Re subject', async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(tokenResponse())
    .mockResolvedValueOnce(
      Response.json({
        id: 'original-1',
        threadId: 'thread-original',
        payload: {
          headers: [
            { name: 'Subject', value: 'Original subject' },
            { name: 'Message-ID', value: '<original@example.com>' },
          ],
        },
      }),
    )
    .mockResolvedValueOnce(Response.json({ id: 'draft-reply' }));
  vi.stubGlobal('fetch', fetcher);
  const client = configuredClient();

  await client.createDraft({
    to: ['recipient@example.com'],
    subject: 'Reply',
    body: '返信です。',
    replyToId: 'original-1',
  });

  const [url, init] = fetcher.mock.calls[2]!;
  expect(String(url)).toBe(
    'https://gmail.googleapis.com/gmail/v1/users/me/drafts',
  );
  const requestBody = JSON.parse(String(init?.body));
  expect(requestBody.message.threadId).toBe('thread-original');
  const raw = Buffer.from(requestBody.message.raw, 'base64url').toString(
    'utf8',
  );
  expect(raw).toContain('In-Reply-To: <original@example.com>\r\n');
  expect(raw).toContain('References: <original@example.com>\r\n');
  expect(raw).toContain(
    `Subject: =?UTF-8?B?${Buffer.from('Re: Reply').toString('base64')}?=`,
  );
});

it('reads nested UTF-8 plain-text parts and truncates the body', async () => {
  const body = 'あ'.repeat(8100);
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(tokenResponse())
    .mockResolvedValueOnce(
      Response.json({
        id: 'message-1',
        threadId: 'thread-1',
        snippet: 'preview',
        payload: {
          headers: [{ name: 'Message-ID', value: '<private@example.com>' }],
          parts: [
            {
              mimeType: 'multipart/alternative',
              parts: [
                {
                  mimeType: 'text/plain',
                  body: {
                    data: Buffer.from(body).toString('base64url'),
                  },
                },
              ],
            },
          ],
        },
      }),
    );
  vi.stubGlobal('fetch', fetcher);
  const client = configuredClient();

  const message = await client.read('message-1');
  expect(message.body).toHaveLength(8000);
  expect(message).not.toHaveProperty('messageIdHeader');
});

it('falls back to HTML mail with tags stripped when there is no plain-text part', async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(tokenResponse())
    .mockResolvedValueOnce(
      Response.json({
        id: 'message-1',
        threadId: 'thread-1',
        payload: {
          parts: [
            {
              mimeType: 'text/html',
              body: {
                data: Buffer.from('<p>Hello <b>there</b></p>').toString(
                  'base64url',
                ),
              },
            },
          ],
        },
      }),
    );
  vi.stubGlobal('fetch', fetcher);
  const client = configuredClient();

  await expect(client.read('message-1')).resolves.toMatchObject({
    body: 'Hello there',
  });
});

it('blocks sending a same-turn draft and permits sending through a fresh tool set', async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(tokenResponse())
    .mockResolvedValueOnce(Response.json({ id: 'draft-created' }))
    .mockResolvedValueOnce(
      Response.json({ id: 'sent-message', threadId: 'sent-thread' }),
    );
  vi.stubGlobal('fetch', fetcher);
  const client = configuredClient();
  const check = vi.fn();
  const sameTurnTools = gmailTools(client, check);

  const draft = await executeTool(sameTurnTools, 'gmail_create_draft', {
    to: ['recipient@example.com'],
    subject: 'Hello',
    body: 'Text',
  });
  expect(draft).toMatchObject({ draftId: 'draft-created' });
  const callCountAfterDraft = fetcher.mock.calls.length;
  await expect(
    executeTool(sameTurnTools, 'gmail_send_draft', {
      draftId: 'draft-created',
    }),
  ).rejects.toThrow(
    'Show this draft to the user and wait for their explicit approval in a new message before sending.',
  );
  expect(fetcher).toHaveBeenCalledTimes(callCountAfterDraft);

  await expect(
    executeTool(gmailTools(client, check), 'gmail_send_draft', {
      draftId: 'draft-created',
    }),
  ).resolves.toEqual({
    messageId: 'sent-message',
    threadId: 'sent-thread',
  });
  const [url, init] = fetcher.mock.calls.at(-1)!;
  expect(String(url)).toBe(
    'https://gmail.googleapis.com/gmail/v1/users/me/drafts/send',
  );
  expect(JSON.parse(String(init?.body))).toEqual({ id: 'draft-created' });
  expect(check).toHaveBeenCalledTimes(3);
});
