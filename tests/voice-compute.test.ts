import { expect, it } from 'vitest';
import {
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
