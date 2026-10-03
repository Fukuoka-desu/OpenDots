import { expect, it } from 'vitest';
import {
  computeStepLabel,
  voiceComputeMarker,
  voiceComputeRequest,
} from '../src/shared/voice-compute.js';

it('extracts and trims the request before the transcript marker', () => {
  expect(
    voiceComputeRequest(
      `  Research this topic.  ${voiceComputeMarker}You: hello`,
    ),
  ).toBe('Research this topic.');
});

it('returns undefined when the transcript marker is absent', () => {
  expect(voiceComputeRequest('Research this topic.')).toBeUndefined();
});

it('preserves multiline requests', () => {
  const request = 'Research this topic.\nInclude the latest evidence.';
  expect(voiceComputeRequest(`${request}${voiceComputeMarker}You: hello`)).toBe(
    request,
  );
});

it('labels web searches with their queries', () => {
  expect(
    computeStepLabel('search_web', {
      search_queries: ['宮古島 天気', '宮古島 風'],
    }),
  ).toEqual({
    label: 'ウェブ検索',
    detail: '宮古島 天気 / 宮古島 風',
  });
});

it('uses the search objective when search queries are unavailable', () => {
  expect(
    computeStepLabel('search_web', { objective: 'Find recent weather data' }),
  ).toEqual({
    label: 'ウェブ検索',
    detail: 'Find recent weather data',
  });
});

it('shows the host for public page reads and omits invalid URLs', () => {
  expect(
    computeStepLabel('read_public_page', { url: 'https://tenki.jp/x' }),
  ).toEqual({ label: 'ページを読む', detail: 'tenki.jp' });
  expect(computeStepLabel('read_public_page', { url: 'not a URL' })).toEqual({
    label: 'ページを読む',
  });
});

it('labels computer tools and unknown tools without exposing arguments', () => {
  expect(
    computeStepLabel('computer_shell_exec', { command: 'private command' }),
  ).toEqual({ label: 'コンピューターで作業' });
  expect(computeStepLabel('unknown_tool', { secret: 'private value' })).toEqual(
    { label: 'ツールを実行' },
  );
});

it('limits progress details to 80 characters', () => {
  const result = computeStepLabel('search_web', {
    objective: 'a'.repeat(100),
  });
  expect(result.detail).toHaveLength(80);
});
