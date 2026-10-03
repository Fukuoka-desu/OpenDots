import { Conversation } from '@elevenlabs/client';
import { api } from '../api';
import type {
  VoiceCallbacks,
  VoiceCallResponse,
  VoiceTransportSession,
} from './types';

export async function connectElevenLabs(
  threadId: string,
  stream: MediaStream,
  callbacks: VoiceCallbacks,
): Promise<VoiceTransportSession> {
  const call = await api<VoiceCallResponse>(
    '/voice/calls',
    'POST',
    { threadId },
    callbacks.signal,
  );
  if (call.provider !== 'elevenlabs')
    throw new Error('Unexpected voice provider.');
  callbacks.onCall(call.id);
  if (callbacks.isCancelled())
    throw new DOMException('Call cancelled.', 'AbortError');
  const conversation = await Conversation.startSession({
    signedUrl: call.signedUrl,
    connectionType: 'websocket',
    textOnly: false,
    overrides: call.overrides,
    inputDeviceId: stream.getAudioTracks()[0]?.getSettings().deviceId,
    clientTools: {
      ask_compute: async ({ request }: { request: string }) => {
        const toolCallId = crypto.randomUUID();
        try {
          return await callbacks.compute(toolCallId, request);
        } catch (error) {
          return `Compute failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
        }
      },
    },
    onConnect: () => callbacks.onActive(),
    onDisconnect: () => {
      if (!callbacks.isCancelled()) callbacks.onClosed();
    },
    onModeChange: ({ mode }) => {
      if (!callbacks.isCancelled()) callbacks.onPhase(mode);
    },
    onAgentToolRequest: () => {
      if (!callbacks.isCancelled()) callbacks.onPhase('thinking');
    },
    onMessage: ({ role, message }) => {
      if (callbacks.isCancelled()) return;
      if (role === 'user') {
        callbacks.onUserCaption(message);
        callbacks.onTranscript(`You: ${message}`);
      } else {
        callbacks.onCaptionReset();
        callbacks.onCaption(message);
        callbacks.onTranscript(`Dot: ${message}`);
      }
    },
    onError: () =>
      callbacks.onError(
        'The voice provider reported a session error. End the call and retry.',
      ),
  });
  if (callbacks.signal.aborted || callbacks.isCancelled()) {
    await conversation.endSession();
    throw new DOMException('Call cancelled.', 'AbortError');
  }
  return {
    setMicMuted: (muted) => conversation.setMicMuted(muted),
    setSpeakerMuted: (muted) =>
      conversation.setVolume({ volume: muted ? 0 : 1 }),
    getLevels: () => ({
      input: conversation.getInputVolume(),
      output: conversation.getOutputVolume(),
    }),
    close: () => conversation.endSession(),
  };
}
