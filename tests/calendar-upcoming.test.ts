import { afterEach, expect, it, vi } from 'vitest';
import {
  calendarRoutes,
  upcomingEvents,
} from '../src/server/calendar-routes.js';
import type { PlatformConfig } from '../src/server/platform-config.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const config = {
  gmailClientId: 'calendar-route-client',
  gmailClientSecret: 'calendar-route-secret',
  gmailRefreshToken: 'calendar-route-refresh',
} as PlatformConfig;

it('rejects minutes outside the supported integer range', async () => {
  const app = calendarRoutes(config);
  for (const minutes of ['0', '1.5', '181', 'invalid']) {
    const response = await app.request(`/calendar/upcoming?minutes=${minutes}`);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'Minutes must be an integer from 1 to 180.',
    });
  }
});

it('returns only timed events starting now or later', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-03T05:00:00.000Z'));
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      Response.json({ access_token: 'calendar-route-token', expires_in: 3600 }),
    )
    .mockResolvedValueOnce(
      Response.json({
        items: [
          {
            id: 'now',
            summary: 'Starting now',
            start: { dateTime: '2026-10-03T14:00:00+09:00' },
          },
          {
            id: 'later',
            summary: 'Later',
            start: { dateTime: '2026-10-03T14:30:00+09:00' },
          },
          {
            id: 'past',
            summary: 'Already started',
            start: { dateTime: '2026-10-03T13:59:00+09:00' },
          },
          {
            id: 'all-day',
            summary: 'All day',
            start: { date: '2026-10-03' },
          },
        ],
      }),
    );
  vi.stubGlobal('fetch', fetcher);

  const response = await calendarRoutes(config).request(
    '/calendar/upcoming?minutes=30',
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    events: [
      {
        id: 'now',
        summary: 'Starting now',
        start: '2026-10-03T14:00:00+09:00',
      },
      {
        id: 'later',
        summary: 'Later',
        start: '2026-10-03T14:30:00+09:00',
      },
    ],
  });
});

it('filters all-day, invalid, and past start values in the pure helper', () => {
  const now = new Date('2026-10-03T05:00:00.000Z');
  expect(
    upcomingEvents(
      [
        { id: 'timed', summary: 'Current', start: '2026-10-03T14:00:00+09:00' },
        { id: 'all-day', summary: 'All day', start: '2026-10-03' },
        { id: 'past', summary: 'Past', start: '2026-10-03T13:00:00+09:00' },
        { id: 'invalid', summary: 'Invalid', start: 'not a date' },
      ],
      now,
    ),
  ).toEqual([
    { id: 'timed', summary: 'Current', start: '2026-10-03T14:00:00+09:00' },
  ]);
});
