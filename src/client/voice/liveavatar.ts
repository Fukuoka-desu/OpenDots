import {
  AgentEventsEnum,
  ElevenLabsAgentSession,
  SessionEvent,
} from '@heygen/liveavatar-web-sdk';
import { createAnalyser, readRms } from './levels';
import type {
  VoiceCallResponse,
  VoiceCallbacks,
  VoiceTransportSession,
} from './types';

type LiveAvatarCall = Extract<VoiceCallResponse, { provider: 'elevenlabs' }> & {
  avatar: { sessionToken: string };
  context: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}

export async function connectLiveAvatar(
  call: LiveAvatarCall,
  stream: MediaStream,
  callbacks: VoiceCallbacks,
  getVideo: () => HTMLVideoElement | null,
): Promise<VoiceTransportSession> {
  const session = new ElevenLabsAgentSession(call.avatar.sessionToken, {
    voiceChat: {
      deviceId: stream.getAudioTracks()[0]?.getSettings().deviceId,
    },
  });
  let closed = false;
  let closing = false;
  let started = false;
  let streamReady = false;
  let speaking = false;
  let speakerMuted = false;
  let attachedVideo: HTMLVideoElement | undefined;
  let fallbackVideo: HTMLVideoElement | undefined;
  let audioContext: AudioContext | undefined;
  let inputSource: MediaStreamAudioSourceNode | undefined;
  let inputAnalyser: AnalyserNode | undefined;
  let outputSource: MediaStreamAudioSourceNode | undefined;
  let outputAnalyser: AnalyserNode | undefined;

  try {
    audioContext = new AudioContext();
    const input = createAnalyser(audioContext, stream);
    inputSource = input.source;
    inputAnalyser = input.analyser;
  } catch {
    audioContext = undefined;
  }

  const clearLocalMedia = () => {
    inputSource?.disconnect();
    outputSource?.disconnect();
    if (attachedVideo) {
      attachedVideo.pause();
      attachedVideo.srcObject = null;
      attachedVideo = undefined;
    }
    if (fallbackVideo) {
      fallbackVideo.remove();
      fallbackVideo = undefined;
    }
    if (audioContext && audioContext.state !== 'closed')
      void audioContext.close();
  };

  const attachVideo = (element: HTMLVideoElement, visible: boolean) => {
    if (closed || !streamReady) return;
    if (attachedVideo !== element) {
      if (attachedVideo) {
        attachedVideo.pause();
        attachedVideo.srcObject = null;
      }
      element.autoplay = true;
      element.playsInline = true;
      element.muted = speakerMuted;
      session.attach(element);
      attachedVideo = element;
      outputSource?.disconnect();
      outputSource = undefined;
      outputAnalyser = undefined;
      if (audioContext && element.srcObject instanceof MediaStream) {
        const tracks = element.srcObject.getAudioTracks();
        if (tracks.length) {
          const output = createAnalyser(audioContext, new MediaStream(tracks));
          outputSource = output.source;
          outputAnalyser = output.analyser;
        }
      }
    }
    callbacks.onAvatarReady?.(visible);
    void element.play().catch(() => {
      if (!callbacks.isCancelled())
        callbacks.onError(
          'Audio playback was blocked. Check your browser audio permissions.',
        );
    });
  };

  const attachCurrentVideo = () => {
    const video = getVideo();
    if (video) {
      attachVideo(video, true);
      return;
    }
    fallbackVideo ??= document.createElement('video');
    fallbackVideo.autoplay = true;
    fallbackVideo.playsInline = true;
    fallbackVideo.muted = speakerMuted;
    fallbackVideo.style.position = 'fixed';
    fallbackVideo.style.width = '1px';
    fallbackVideo.style.height = '1px';
    fallbackVideo.style.opacity = '0';
    fallbackVideo.style.pointerEvents = 'none';
    if (!fallbackVideo.isConnected) document.body.append(fallbackVideo);
    attachVideo(fallbackVideo, false);
  };

  const close = async () => {
    closing = true;
    if (!started || closed) return;
    closed = true;
    callbacks.signal.removeEventListener('abort', onAbort);
    callbacks.onAvatarReady?.(false);
    clearLocalMedia();
    await session.stop();
  };
  const onAbort = () => {
    void close();
  };

  session.on(SessionEvent.SESSION_STREAM_READY, () => {
    if (callbacks.isCancelled()) return;
    streamReady = true;
    attachCurrentVideo();
  });
  session.on(SessionEvent.SESSION_DISCONNECTED, () => {
    if (!callbacks.isCancelled()) callbacks.onClosed();
  });
  session.on(AgentEventsEnum.SESSION_STOPPED, () => {
    if (!callbacks.isCancelled()) callbacks.onClosed();
  });
  session.on(AgentEventsEnum.AVATAR_SPEAK_STARTED, () => {
    if (callbacks.isCancelled()) return;
    speaking = true;
    callbacks.onCaptionReset();
    callbacks.onPhase('speaking');
  });
  session.on(AgentEventsEnum.AVATAR_SPEAK_ENDED, () => {
    if (callbacks.isCancelled()) return;
    speaking = false;
    callbacks.onPhase('listening');
  });
  session.on(AgentEventsEnum.AVATAR_TRANSCRIPTION_CHUNK, ({ text }) => {
    if (!callbacks.isCancelled()) callbacks.onCaption(text);
  });
  session.on(AgentEventsEnum.AVATAR_TRANSCRIPTION, ({ text }) => {
    if (callbacks.isCancelled()) return;
    callbacks.onCaptionReset();
    callbacks.onCaption(text);
    callbacks.onTranscript(`Dot: ${text}`);
  });
  session.on(AgentEventsEnum.USER_TRANSCRIPTION_CHUNK, ({ text }) => {
    if (!callbacks.isCancelled()) callbacks.onUserCaption(text);
  });
  session.on(AgentEventsEnum.USER_TRANSCRIPTION, ({ text }) => {
    if (callbacks.isCancelled()) return;
    callbacks.onUserCaption(text);
    callbacks.onTranscript(`You: ${text}`);
  });
  session.on(
    AgentEventsEnum.ELEVENLABS_AGENT_EVENT,
    async ({ elevenlabs_event_type, data }) => {
      if (
        callbacks.isCancelled() ||
        closed ||
        elevenlabs_event_type !== 'client_tool_call' ||
        !isRecord(data)
      )
        return;
      const toolCall = isRecord(data.client_tool_call)
        ? data.client_tool_call
        : data;
      if (
        toolCall.tool_name !== 'ask_compute' ||
        typeof toolCall.tool_call_id !== 'string' ||
        !isRecord(toolCall.parameters) ||
        typeof toolCall.parameters.request !== 'string'
      )
        return;
      callbacks.onPhase('thinking');
      let result: string;
      let isError = false;
      try {
        result = await callbacks.compute(
          crypto.randomUUID(),
          toolCall.parameters.request,
        );
      } catch (error) {
        isError = true;
        result = `Compute failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
      }
      if (closed || callbacks.isCancelled()) return;
      session.sendClientToolResult({
        toolCallId: toolCall.tool_call_id,
        result,
        isError,
      });
    },
  );

  callbacks.signal.addEventListener('abort', onAbort, { once: true });
  try {
    await session.start();
    started = true;
    if (closing || callbacks.isCancelled()) {
      await close();
      throw new DOMException('Call cancelled.', 'AbortError');
    }
    session.sendContextualUpdate(call.context);
    callbacks.onActive();
  } catch (error) {
    if (started) {
      await close();
    } else {
      callbacks.signal.removeEventListener('abort', onAbort);
      clearLocalMedia();
    }
    throw error;
  }

  return {
    setMicMuted: (muted) => {
      if (muted) void session.voiceChat.mute();
      else void session.voiceChat.unmute();
    },
    setSpeakerMuted: (muted) => {
      speakerMuted = muted;
      if (attachedVideo) attachedVideo.muted = muted;
    },
    attachAvatarVideo: (element) => {
      if (!element) {
        callbacks.onAvatarReady?.(false);
        if (streamReady) attachCurrentVideo();
      } else {
        attachVideo(element, true);
      }
    },
    getLevels: () => ({
      input: readRms(inputAnalyser),
      output: outputAnalyser ? readRms(outputAnalyser) : speaking ? 0.18 : 0,
    }),
    close,
  };
}
