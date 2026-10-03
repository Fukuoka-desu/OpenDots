import { expect, it } from 'vitest';
import {
  dueReport,
  jstDay,
  reportSlots,
  slotForNow,
} from '../src/client/reports.js';

it('returns nothing before the first daily report time', () => {
  expect(dueReport(new Date('2026-10-02T23:59:00.000Z'), [])).toBeUndefined();
});

it('returns the morning report once it is due and skips completed slots', () => {
  const now = new Date('2026-10-03T00:05:00.000Z');
  expect(dueReport(now, [])).toEqual({
    slot: reportSlots[0],
    handled: ['morning'],
  });
  expect(dueReport(now, ['morning'])).toBeUndefined();
});

it('handles all due slots but sends only the latest one', () => {
  expect(dueReport(new Date('2026-10-03T04:00:00.000Z'), [])).toEqual({
    slot: reportSlots[1],
    handled: ['morning', 'noon'],
  });
});

it('marks stale slots handled without sending a report', () => {
  expect(dueReport(new Date('2026-10-03T12:00:00.000Z'), [])).toEqual({
    handled: ['morning', 'noon', 'evening'],
  });
});

it('sends the evening report while it is within three hours', () => {
  expect(dueReport(new Date('2026-10-03T11:00:00.000Z'), [])).toEqual({
    slot: reportSlots[2],
    handled: ['morning', 'noon', 'evening'],
  });
});

it('uses the Tokyo day across UTC midnight', () => {
  expect(jstDay(new Date('2026-10-03T16:00:00.000Z'))).toBe('2026-10-04');
});

it('chooses the manual report slot at Tokyo hour boundaries', () => {
  expect(slotForNow(new Date('2026-10-03T01:59:00.000Z')).id).toBe('morning');
  expect(slotForNow(new Date('2026-10-03T02:00:00.000Z')).id).toBe('noon');
  expect(slotForNow(new Date('2026-10-03T05:59:00.000Z')).id).toBe('noon');
  expect(slotForNow(new Date('2026-10-03T06:00:00.000Z')).id).toBe('evening');
});
