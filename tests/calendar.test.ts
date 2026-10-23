import { afterEach, expect, it, vi } from 'vitest';
import { CalendarClient } from '../src/server/calendar.js';
import { GmailClient } from '../src/server/gmail.js';
import { GoogleAuth } from '../src/server/google-auth.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function configuredAuth() {
  return new GoogleAuth({
    clientId: 'test-client-id',
    clientSecret: 'test-client-secret',
    refreshToken: 'test-refresh-token',
  });
}

function tokenResponse() {
  return Response.json({ access_token: 'test-access-token', expires_in: 3600 });
}

it('lists the default week of events and maps event fields', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-05T06:00:00.000Z'));
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(tokenResponse())
    .mockResolvedValueOnce(
      Response.json({
        items: [
          {
            id: 'event-1',
            summary: 'Planning',
            start: { dateTime: '2026-10-05T15:00:00+09:00' },
            end: { date: '2026-10-06' },
            location: 'Tokyo',
            attendees: [{}, {}],
            htmlLink: 'https://calendar.example/events/event-1',
          },
        ],
      }),
    );
  vi.stubGlobal('fetch', fetcher);
  const client = new CalendarClient(configuredAuth());

  await expect(client.listEvents()).resolves.toEqual([
    {
      id: 'event-1',
      summary: 'Planning',
      start: '2026-10-05T15:00:00+09:00',
      end: '2026-10-06',
      location: 'Tokyo',
      attendees: 2,
      htmlLink: 'https://calendar.example/events/event-1',
    },
  ]);

  const [url, init] = fetcher.mock.calls[1]!;
  const requestUrl = new URL(String(url));
  expect(requestUrl.origin).toBe('https://www.googleapis.com');
  expect(requestUrl.pathname).toBe('/calendar/v3/calendars/primary/events');
  expect(Object.fromEntries(requestUrl.searchParams)).toEqual({
    singleEvents: 'true',
    orderBy: 'startTime',
    timeMin: '2026-10-05T06:00:00.000Z',
    timeMax: '2026-10-12T06:00:00.000Z',
    maxResults: '20',
  });
  expect(new Headers(init?.headers).get('Authorization')).toBe(
    'Bearer test-access-token',
  );
});

it('creates a Tokyo-time event without attendees or invitation updates', async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(tokenResponse())
    .mockResolvedValueOnce(
      Response.json({
        id: 'event-2',
        summary: 'Appointment',
        start: { dateTime: '2026-10-05T15:00:00+09:00' },
        end: { dateTime: '2026-10-05T16:00:00+09:00' },
        htmlLink: 'https://calendar.example/events/event-2',
      }),
    );
  vi.stubGlobal('fetch', fetcher);
  const client = new CalendarClient(configuredAuth());
  const event = {
    summary: 'Appointment',
    start: '2026-10-05T15:00:00+09:00',
    end: '2026-10-05T16:00:00+09:00',
    description: 'Discuss the proposal.',
    location: 'Tokyo office',
  };

  await expect(client.createEvent(event)).resolves.toEqual({
    id: 'event-2',
    summary: 'Appointment',
    start: event.start,
    end: event.end,
    htmlLink: 'https://calendar.example/events/event-2',
  });

  const [url, init] = fetcher.mock.calls[1]!;
  const requestUrl = new URL(String(url));
  expect(requestUrl.pathname).toBe('/calendar/v3/calendars/primary/events');
  expect(requestUrl.searchParams.get('sendUpdates')).toBe('none');
  expect(JSON.parse(String(init?.body))).toEqual({
    summary: event.summary,
    start: { dateTime: event.start, timeZone: 'Asia/Tokyo' },
    end: { dateTime: event.end, timeZone: 'Asia/Tokyo' },
    description: event.description,
    location: event.location,
  });
  expect(JSON.parse(String(init?.body))).not.toHaveProperty('attendees');
});

it('rejects invalid or non-positive event intervals without fetching', async () => {
  const fetcher = vi.fn<typeof fetch>();
  vi.stubGlobal('fetch', fetcher);
  const client = new CalendarClient(configuredAuth());
  const start = '2026-10-05T15:00:00+09:00';

  await expect(
    client.createEvent({
      summary: 'Invalid',
      start,
      end: start,
    }),
  ).rejects.toThrow('Event end must be after its start.');
  await expect(
    client.createEvent({
      summary: 'Invalid',
      start: 'not-a-date',
      end: 'also-not-a-date',
    }),
  ).rejects.toThrow('start must be an ISO 8601 date-time with an offset.');
  expect(fetcher).not.toHaveBeenCalled();
});

it('shares one refresh-token exchange across Gmail and Calendar clients', async () => {
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    if (url === 'https://oauth2.googleapis.com/token') return tokenResponse();
    if (url.includes('/gmail/v1/users/me/messages?'))
      return Response.json({ messages: [{ id: 'message-1' }] });
    if (url.includes('/gmail/v1/users/me/messages/message-1?'))
      return Response.json({
        id: 'message-1',
        threadId: 'thread-1',
        payload: { headers: [] },
      });
    if (url.includes('/calendar/v3/calendars/primary/events'))
      return Response.json({ items: [] });
    throw new Error(`Unexpected fetch: ${url}`);
  });
  vi.stubGlobal('fetch', fetcher);
  const auth = configuredAuth();
  const gmail = new GmailClient(auth);
  const calendar = new CalendarClient(auth);

  await Promise.all([gmail.search('is:unread'), calendar.listEvents()]);

  expect(
    fetcher.mock.calls.filter(([url]) =>
      String(url).includes('oauth2.googleapis.com/token'),
    ),
  ).toHaveLength(1);
  expect(fetcher).toHaveBeenCalledTimes(4);
});
