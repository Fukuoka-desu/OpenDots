import { defineTool } from '@copilotkit/runtime/v2';
import { z } from 'zod';
import { GoogleAuth } from './google-auth.js';

const calendarApiUrl =
  'https://www.googleapis.com/calendar/v3/calendars/primary';
const oneWeekMs = 7 * 24 * 60 * 60 * 1000;
const isoDateTime =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i;

type CalendarListOptions = {
  timeMin?: string;
  timeMax?: string;
  maxResults?: number;
};

type CalendarEventInput = {
  summary: string;
  start: string;
  end: string;
  description?: string;
  location?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function requiredDateTime(value: string, field: string) {
  if (!isoDateTime.test(value))
    throw new Error(`${field} must be an ISO 8601 date-time with an offset.`);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp))
    throw new Error(`${field} must be a valid ISO 8601 date-time.`);
  return timestamp;
}

function eventTime(value: unknown) {
  if (!isRecord(value)) return '';
  if (typeof value.dateTime === 'string') return value.dateTime;
  if (typeof value.date === 'string') return value.date;
  return '';
}

function stringField(value: unknown, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

export class CalendarClient {
  constructor(private auth: GoogleAuth) {}

  async listEvents(options: CalendarListOptions = {}) {
    if (!this.auth.configured)
      throw new Error(
        'Google Calendar is not configured with OAuth credentials.',
      );

    const now = Date.now();
    const timeMin = options.timeMin ?? new Date(now).toISOString();
    const timeMax = options.timeMax ?? new Date(now + oneWeekMs).toISOString();
    requiredDateTime(timeMin, 'timeMin');
    requiredDateTime(timeMax, 'timeMax');
    const requestedMax = options.maxResults ?? 20;
    const maxResults = Math.max(
      1,
      Math.min(50, Number.isNaN(requestedMax) ? 20 : Math.floor(requestedMax)),
    );
    const params = new URLSearchParams({
      singleEvents: 'true',
      orderBy: 'startTime',
      timeMin,
      timeMax,
      maxResults: String(maxResults),
    });
    const result = await this.auth.request<{ items?: unknown }>(
      `${calendarApiUrl}/events?${params.toString()}`,
    );
    const items = Array.isArray(result.items) ? result.items : [];
    return items.filter(isRecord).map((event) => ({
      id: stringField(event.id),
      summary: stringField(event.summary),
      start: eventTime(event.start),
      end: eventTime(event.end),
      location: stringField(event.location),
      attendees: Array.isArray(event.attendees) ? event.attendees.length : 0,
      htmlLink: stringField(event.htmlLink),
    }));
  }

  async createEvent(input: CalendarEventInput) {
    if (!this.auth.configured)
      throw new Error(
        'Google Calendar is not configured with OAuth credentials.',
      );
    const start = requiredDateTime(input.start, 'start');
    const end = requiredDateTime(input.end, 'end');
    if (end <= start) throw new Error('Event end must be after its start.');

    const params = new URLSearchParams({ sendUpdates: 'none' });
    const result = await this.auth.request<Record<string, unknown>>(
      `${calendarApiUrl}/events?${params.toString()}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          summary: input.summary,
          start: { dateTime: input.start, timeZone: 'Asia/Tokyo' },
          end: { dateTime: input.end, timeZone: 'Asia/Tokyo' },
          description: input.description,
          location: input.location,
        }),
      },
    );
    return {
      id: stringField(result.id),
      summary: stringField(result.summary, input.summary),
      start: eventTime(result.start) || input.start,
      end: eventTime(result.end) || input.end,
      htmlLink: stringField(result.htmlLink),
    };
  }
}

export function calendarTools(client: CalendarClient, check: () => void) {
  return [
    defineTool({
      name: 'calendar_list_events',
      description:
        "List events on the owner's primary Google Calendar. Defaults to the current time through the next seven days.",
      parameters: z.object({
        timeMin: z
          .string()
          .optional()
          .describe(
            'Optional ISO 8601 date-time lower bound, including offset.',
          ),
        timeMax: z
          .string()
          .optional()
          .describe(
            'Optional ISO 8601 date-time upper bound, including offset.',
          ),
        maxResults: z.number().int().min(1).max(50).optional(),
      }),
      execute: async (input) => {
        check();
        return client.listEvents(input);
      },
    }),
    defineTool({
      name: 'calendar_create_event',
      description:
        "Create an event on the owner's primary Google Calendar. Confirm the date and time with the user first unless they stated an exact date and time. This creates an event for the owner only and does not invite attendees.",
      parameters: z.object({
        summary: z.string().min(1),
        start: z
          .string()
          .describe(
            'ISO 8601 date-time with offset, e.g. 2026-10-05T15:00:00+09:00.',
          ),
        end: z
          .string()
          .describe(
            'ISO 8601 date-time with offset, e.g. 2026-10-05T16:00:00+09:00.',
          ),
        description: z.string().optional(),
        location: z.string().optional(),
      }),
      execute: async (input) => {
        check();
        return client.createEvent(input);
      },
    }),
  ];
}
