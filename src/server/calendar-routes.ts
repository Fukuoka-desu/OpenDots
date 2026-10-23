import { Hono } from 'hono';
import type { PlatformConfig } from './platform-config.js';
import { CalendarClient } from './calendar.js';
import { sharedGoogleAuth } from './google-auth.js';

type UpcomingEvent = { id: string; summary: string; start: string };

export function upcomingEvents(
  events: UpcomingEvent[],
  now: Date,
): UpcomingEvent[] {
  return events
    .filter((event) => {
      if (!/^\d{4}-\d{2}-\d{2}T/.test(event.start)) return false;
      const start = Date.parse(event.start);
      return Number.isFinite(start) && start >= now.getTime();
    })
    .map(({ id, summary, start }) => ({ id, summary, start }));
}

export function calendarRoutes(config: PlatformConfig) {
  const app = new Hono();
  const auth = sharedGoogleAuth({
    clientId: config.gmailClientId,
    clientSecret: config.gmailClientSecret,
    refreshToken: config.gmailRefreshToken,
  });
  const calendar = new CalendarClient(auth);

  app.get('/calendar/upcoming', async (c) => {
    const value = c.req.query('minutes');
    const minutes = value === undefined ? 30 : Number(value);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 180)
      return c.json(
        { error: 'Minutes must be an integer from 1 to 180.' },
        400,
      );
    if (!auth.configured)
      return c.json({ error: 'Google Calendar is not configured.' }, 409);

    const now = new Date();
    try {
      const events = await calendar.listEvents({
        timeMin: now.toISOString(),
        timeMax: new Date(now.getTime() + minutes * 60_000).toISOString(),
        maxResults: 10,
      });
      return c.json({ events: upcomingEvents(events, now) });
    } catch (error) {
      return c.json(
        {
          error:
            error instanceof Error ? error.message : 'Google Calendar failed.',
        },
        502,
      );
    }
  });

  return app;
}
