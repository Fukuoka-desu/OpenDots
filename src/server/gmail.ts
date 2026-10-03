import { defineTool } from '@copilotkit/runtime/v2';
import { z } from 'zod';
import { GoogleAuth, type GoogleAuthConfig } from './google-auth.js';

const gmailApiUrl = 'https://gmail.googleapis.com/gmail/v1/users/me';
const emailAddresses = new WeakMap<GoogleAuth, Promise<string>>();

type GmailMessage = {
  id: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  snippet: string;
};

type GmailMessageResource = {
  id?: unknown;
  threadId?: unknown;
  snippet?: unknown;
  payload?: unknown;
};

type GmailApiResponse = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function headerValue(headers: unknown, name: string): string {
  if (!Array.isArray(headers)) return '';
  const header = headers.find(
    (item) =>
      isRecord(item) &&
      typeof item.name === 'string' &&
      item.name.toLowerCase() === name.toLowerCase(),
  );
  return isRecord(header) && typeof header.value === 'string'
    ? header.value
    : '';
}

function decodePart(part: unknown): string | undefined {
  if (!isRecord(part)) return undefined;
  if (
    isRecord(part.body) &&
    typeof part.body.data === 'string' &&
    part.body.data
  )
    return Buffer.from(part.body.data, 'base64url').toString('utf8');
  return undefined;
}

function findBody(
  payload: unknown,
  mimeType: 'text/plain' | 'text/html',
): string | undefined {
  if (!isRecord(payload)) return undefined;
  if (payload.mimeType === mimeType) {
    const decoded = decodePart(payload);
    if (decoded !== undefined) return decoded;
  }
  if (Array.isArray(payload.parts)) {
    for (const part of payload.parts) {
      const decoded = findBody(part, mimeType);
      if (decoded !== undefined) return decoded;
    }
  }
  return undefined;
}

function htmlToText(html: string) {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function assertHeaderValue(value: string) {
  if (/[\r\n]/.test(value))
    throw new Error('Email header values cannot contain CR or LF.');
}

function base64Lines(value: string) {
  const encoded = Buffer.from(value, 'utf8').toString('base64');
  return encoded.match(/.{1,76}/g)?.join('\r\n') ?? '';
}

function rawBase64Url(value: string) {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function messageFields(resource: GmailMessageResource): GmailMessage {
  const payload = isRecord(resource.payload) ? resource.payload : undefined;
  const headers = payload?.headers;
  return {
    id: typeof resource.id === 'string' ? resource.id : '',
    threadId: typeof resource.threadId === 'string' ? resource.threadId : '',
    from: headerValue(headers, 'From'),
    to: headerValue(headers, 'To'),
    subject: headerValue(headers, 'Subject'),
    date: headerValue(headers, 'Date'),
    snippet: typeof resource.snippet === 'string' ? resource.snippet : '',
  };
}

export class GmailClient {
  private auth: GoogleAuth;

  constructor(auth: GoogleAuth | GoogleAuthConfig) {
    this.auth = auth instanceof GoogleAuth ? auth : new GoogleAuth(auth);
  }

  get configured() {
    return this.auth.configured;
  }

  async emailAddress() {
    const cached = emailAddresses.get(this.auth);
    if (cached) return cached;

    const request = this.api('/profile').then((profile) => {
      if (typeof profile.emailAddress !== 'string' || !profile.emailAddress)
        throw new Error('Gmail profile did not return an email address.');
      return profile.emailAddress;
    });
    emailAddresses.set(this.auth, request);
    try {
      return await request;
    } catch (error) {
      if (emailAddresses.get(this.auth) === request)
        emailAddresses.delete(this.auth);
      throw error;
    }
  }

  private async api(
    path: string,
    init: RequestInit = {},
  ): Promise<GmailApiResponse> {
    if (!this.configured)
      throw new Error('Gmail is not configured with OAuth credentials.');
    return this.auth.request<GmailApiResponse>(`${gmailApiUrl}${path}`, init);
  }

  private async getMessage(id: string, format: 'metadata' | 'full') {
    const params = new URLSearchParams({ format });
    if (format === 'metadata') {
      for (const header of ['From', 'To', 'Subject', 'Date'])
        params.append('metadataHeaders', header);
    }
    const payload = await this.api(
      `/messages/${encodeURIComponent(id)}?${params.toString()}`,
    );
    const resource = payload as GmailMessageResource;
    const fields = messageFields(resource);
    const messagePayload = isRecord(resource.payload)
      ? resource.payload
      : undefined;
    const plainText = findBody(messagePayload, 'text/plain');
    const html =
      plainText === undefined
        ? findBody(messagePayload, 'text/html')
        : undefined;
    return {
      ...fields,
      body: (plainText ?? (html === undefined ? '' : htmlToText(html))).slice(
        0,
        8000,
      ),
      messageIdHeader: headerValue(messagePayload?.headers, 'Message-ID'),
    };
  }

  async search(query: string, max = 10): Promise<GmailMessage[]> {
    const normalizedMax = Number.isNaN(max) ? 10 : Math.floor(max);
    const maxResults = Math.max(1, Math.min(20, normalizedMax));
    const params = new URLSearchParams({
      q: query,
      maxResults: String(maxResults),
    });
    const result = await this.api(`/messages?${params.toString()}`);
    const messages = Array.isArray(result.messages) ? result.messages : [];
    return Promise.all(
      messages.map(async (message) => {
        if (!isRecord(message) || typeof message.id !== 'string')
          throw new Error('Gmail returned a message without an ID.');
        const summary = await this.getMessage(message.id, 'metadata');
        return {
          id: summary.id,
          threadId: summary.threadId,
          from: summary.from,
          to: summary.to,
          subject: summary.subject,
          date: summary.date,
          snippet: summary.snippet,
        };
      }),
    );
  }

  async read(id: string) {
    const message = await this.getMessage(id, 'full');
    return {
      id: message.id,
      threadId: message.threadId,
      from: message.from,
      to: message.to,
      subject: message.subject,
      date: message.date,
      snippet: message.snippet,
      body: message.body,
    };
  }

  async createDraft(input: {
    to: string[];
    cc?: string[];
    subject: string;
    body: string;
    replyToId?: string;
  }) {
    for (const recipient of [...input.to, ...(input.cc ?? [])])
      assertHeaderValue(recipient);
    assertHeaderValue(input.subject);

    let threadId: string | undefined;
    let subject = input.subject;
    let replyHeaders: string[] = [];
    if (input.replyToId) {
      const original = await this.getMessage(input.replyToId, 'full');
      if (!original.messageIdHeader)
        throw new Error('Reply target does not include a Message-ID header.');
      if (!original.threadId)
        throw new Error('Reply target does not include a thread ID.');
      assertHeaderValue(original.messageIdHeader);
      threadId = original.threadId;
      if (!/^re:/i.test(subject)) subject = `Re: ${subject}`;
      replyHeaders = [
        `In-Reply-To: ${original.messageIdHeader}`,
        `References: ${original.messageIdHeader}`,
      ];
    }
    assertHeaderValue(subject);

    const headers = [
      `To: ${input.to.join(', ')}`,
      ...(input.cc?.length ? [`Cc: ${input.cc.join(', ')}`] : []),
      `Subject: =?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`,
      ...replyHeaders,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      base64Lines(input.body),
    ];
    const body: { message: { raw: string; threadId?: string } } = {
      message: { raw: rawBase64Url(headers.join('\r\n')) },
    };
    if (threadId) body.message.threadId = threadId;
    const result = await this.api('/drafts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (typeof result.id !== 'string' || !result.id)
      throw new Error('Gmail did not return a draft ID.');
    return {
      draftId: result.id,
      to: input.to,
      cc: input.cc ?? [],
      subject,
      body: input.body,
    };
  }

  async sendDraft(draftId: string) {
    const result = await this.api('/drafts/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: draftId }),
    });
    if (typeof result.id !== 'string' || !result.id)
      throw new Error('Gmail did not return a sent message ID.');
    return {
      messageId: result.id,
      threadId: typeof result.threadId === 'string' ? result.threadId : '',
    };
  }
}

export function gmailTools(client: GmailClient, check: () => void) {
  const draftsCreatedHere = new Set<string>();
  return [
    defineTool({
      name: 'gmail_search_messages',
      description:
        'Search the owner’s Gmail mailbox using Gmail search syntax.',
      parameters: z.object({
        query: z
          .string()
          .describe('Gmail search syntax, e.g. "is:unread newer_than:1d".'),
        maxResults: z.number().int().min(1).max(20).optional(),
      }),
      execute: async ({ query, maxResults }) => {
        check();
        return client.search(query, maxResults);
      },
    }),
    defineTool({
      name: 'gmail_read_message',
      description: 'Read a message from the owner’s Gmail mailbox.',
      parameters: z.object({ id: z.string().min(1) }),
      execute: async ({ id }) => {
        check();
        return client.read(id);
      },
    }),
    defineTool({
      name: 'gmail_create_draft',
      description:
        'Creates a draft only. Afterwards show the user the recipients, subject and full body and ask whether to send.',
      parameters: z.object({
        to: z.array(z.string().email()).min(1).max(20),
        cc: z.array(z.string().email()).max(20).optional(),
        subject: z.string().max(300),
        body: z.string().max(20000),
        replyToId: z.string().min(1).optional(),
      }),
      execute: async (input) => {
        check();
        const draft = await client.createDraft(input);
        draftsCreatedHere.add(draft.draftId);
        return draft;
      },
    }),
    defineTool({
      name: 'gmail_send_draft',
      description:
        'Send only a draft the user explicitly approved in their latest message after seeing it.',
      parameters: z.object({ draftId: z.string().min(1) }),
      execute: async ({ draftId }) => {
        check();
        if (draftsCreatedHere.has(draftId))
          throw new Error(
            'Show this draft to the user and wait for their explicit approval in a new message before sending.',
          );
        return client.sendDraft(draftId);
      },
    }),
  ];
}
