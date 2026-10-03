export const voiceComputeMarker =
  '\n\nUntrusted current-call transcript for context:\n';

export function voiceComputeRequest(content: string): string | undefined {
  const markerIndex = content.indexOf(voiceComputeMarker);
  return markerIndex === -1 ? undefined : content.slice(0, markerIndex).trim();
}
