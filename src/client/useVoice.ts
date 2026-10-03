import { useCallback, useEffect, useRef, useState } from 'react';
import { api, authHeaders } from './api';
import { connectElevenLabs } from './voice/elevenlabs';
import { connectGemini } from './voice/gemini';
import { connectLiveAvatar } from './voice/liveavatar';
import { connectOpenAI } from './voice/openai';
import type {
  VoiceCallbacks,
  VoiceCallResponse,
  VoiceProvider,
  VoiceTransportSession,
} from './voice/types';

type VoiceCallSession = {
  stream: MediaStream;
  id?: string;
  transcript: string[];
  timer?: ReturnType<typeof setTimeout>;
  cancelled: boolean;
  abort: AbortController;
  transport?: VoiceTransportSession;
};

export function useVoice(
  threadId: string,
  onSaved: () => void,
  provider: VoiceProvider,
  anchorMessageId?: string,
) {
  const [status, setStatus] = useState<
    'idle' | 'connecting' | 'active' | 'ending'
  >('idle');
  const generation = useRef(0);
  const connecting = useRef(false);
  const ending = useRef(false);
  const [error, setError] = useState('');
  const [muted, setMuted] = useState(false);
  const [speakerMuted, setSpeakerMuted] = useState(false);
  const [startedAt, setStartedAt] = useState<number>();
  const [phase, setPhase] = useState<'listening' | 'speaking' | 'thinking'>(
    'listening',
  );
  const [caption, setCaption] = useState('');
  const [userCaption, setUserCaption] = useState('');
  const [turns, setTurns] = useState<
    { id: number; role: 'you' | 'ai'; text: string }[]
  >([]);
  const session = useRef<VoiceCallSession | undefined>(undefined);
  const video = useRef<HTMLVideoElement | null>(null);
  const [avatarReady, setAvatarReady] = useState(false);
  const anchor = useRef(anchorMessageId);
  anchor.current = anchorMessageId;
  const avatarVideo = useCallback((element: HTMLVideoElement | null) => {
    video.current = element;
    session.current?.transport?.attachAvatarVideo?.(element);
  }, []);
  const closeMedia = useCallback(() => {
    const current = session.current;
    if (!current) return;
    current.cancelled = true;
    current.abort.abort();
    current.stream.getTracks().forEach((track) => track.stop());
    void current.transport?.close();
    clearTimeout(current.timer);
  }, []);
  const end = useCallback(async () => {
    if (ending.current) return;
    generation.current++;
    connecting.current = false;
    const current = session.current;
    if (!current) {
      setStatus('idle');
      return;
    }
    current.cancelled = true;
    current.transport?.setMicMuted(true);
    current.transport?.setSpeakerMuted(true);
    if (!current.transport) current.abort.abort();
    current.stream.getTracks().forEach((track) => {
      track.enabled = false;
    });
    clearTimeout(current.timer);
    ending.current = true;
    setStatus('ending');
    try {
      if (current.id)
        await api(`/voice/calls/${current.id}/end`, 'POST', {
          transcript: current.transcript.join('\n').slice(0, 20000),
          anchorMessageId: anchor.current,
        });
      onSaved();
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : 'Call ended, but its receipt could not be saved.',
      );
    } finally {
      closeMedia();
      session.current = undefined;
      ending.current = false;
      setStatus('idle');
    }
  }, [closeMedia, onSaved]);
  useEffect(
    () => () => {
      generation.current++;
      const current = session.current;
      closeMedia();
      if (current?.id && !ending.current)
        void fetch(`/api/voice/calls/${current.id}/end`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders() },
          body: JSON.stringify({
            transcript: current.transcript.join('\n').slice(0, 20000),
            anchorMessageId: anchor.current,
          }),
          keepalive: true,
        }).catch(() => {});
    },
    [closeMedia],
  );
  useEffect(() => {
    if (status !== 'active' && status !== 'connecting') return;
    const timer = setInterval(() => {
      const current = session.current;
      const id = current?.id;
      if (id)
        void api<{ endedAt: number | null }>(`/voice/calls/${id}`)
          .then((call) => {
            if (session.current === current && call.endedAt) void end();
          })
          .catch(() => {
            if (session.current !== current) return;
            setError('Call control connection was lost.');
            void end();
          });
    }, 2000);
    return () => clearInterval(timer);
  }, [status, closeMedia, onSaved, end]);
  const start = async () => {
    if (session.current || connecting.current || ending.current) return;
    connecting.current = true;
    const attempt = ++generation.current;
    setStatus('connecting');
    setError('');
    setMuted(false);
    setSpeakerMuted(false);
    setStartedAt(undefined);
    setPhase('listening');
    setCaption('');
    setUserCaption('');
    setAvatarReady(false);
    setTurns([]);
    let stream: MediaStream | undefined;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      if (attempt !== generation.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      const current: VoiceCallSession = {
        stream,
        transcript: [],
        cancelled: false,
        abort: new AbortController(),
      };
      session.current = current;
      const callbacks: VoiceCallbacks = {
        signal: current.abort.signal,
        isCancelled: () => current.cancelled || attempt !== generation.current,
        onCall: (id) => {
          current.id = id;
          if (current.cancelled || attempt !== generation.current)
            void api(`/voice/calls/${id}/end`, 'POST', {
              transcript: '',
              anchorMessageId: anchor.current,
            }).catch(() => {});
        },
        onActive: () => {
          if (current.cancelled || attempt !== generation.current) return;
          setStatus('active');
          setStartedAt((value) => value ?? Date.now());
          if (current.id)
            void api(`/voice/calls/${current.id}/active`, 'POST', {}).catch(
              (e) => {
                if (!current.cancelled) setError(e.message);
              },
            );
        },
        onPhase: setPhase,
        onCaption: (text) => setCaption((value) => value + text),
        onCaptionReset: () => setCaption(''),
        onUserCaption: setUserCaption,
        onTranscript: (line) => {
          current.transcript.push(line);
          const role = line.startsWith('You: ') ? 'you' : 'ai';
          const text = line.replace(/^(You|Dot): /, '');
          setTurns((list) => [...list, { id: list.length, role, text }]);
        },
        onAvatarReady: setAvatarReady,
        onError: setError,
        onClosed: () => {
          if (!current.cancelled) void end();
        },
        compute: async (toolCallId, request) => {
          if (!current.id) throw new Error('Call is not ready for compute.');
          const result = await api<{ text: string }>(
            `/voice/calls/${current.id}/compute`,
            'POST',
            {
              toolCallId,
              request,
              transcript: current.transcript.join('\n').slice(-12000),
            },
          );
          return result.text;
        },
      };
      let usesAvatar = false;
      if (provider === 'elevenlabs') {
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
        if ('avatar' in call) {
          usesAvatar = true;
          current.transport = await connectLiveAvatar(
            call,
            stream,
            callbacks,
            () => video.current,
          );
        } else {
          current.transport = await connectElevenLabs(
            threadId,
            stream,
            callbacks,
            call,
          );
        }
      } else {
        const connect = provider === 'openai' ? connectOpenAI : connectGemini;
        current.transport = await connect(threadId, stream, callbacks);
      }
      if (current.cancelled || attempt !== generation.current) {
        await current.transport.close();
        return;
      }
      if (provider === 'elevenlabs' && !usesAvatar)
        stream.getTracks().forEach((track) => track.stop());
      current.timer = setTimeout(() => void end(), 15 * 60_000);
    } catch (e) {
      if (attempt !== generation.current) {
        stream?.getTracks().forEach((track) => track.stop());
        return;
      }
      const current = session.current;
      const id = current?.id;
      if (id)
        void api(`/voice/calls/${id}/end`, 'POST', {
          transcript: '',
          anchorMessageId: anchor.current,
        }).catch(() => {});
      stream?.getTracks().forEach((track) => track.stop());
      closeMedia();
      session.current = undefined;
      setStatus('idle');
      setAvatarReady(false);
      if (!(e instanceof DOMException && e.name === 'AbortError'))
        setError(
          e instanceof Error ? e.message : 'Could not connect the call.',
        );
    } finally {
      if (attempt === generation.current) connecting.current = false;
    }
  };
  const toggleMute = () => {
    const next = !muted;
    session.current?.transport?.setMicMuted(next);
    session.current?.stream.getAudioTracks().forEach((track) => {
      track.enabled = !next;
    });
    setMuted(next);
  };
  const toggleSpeaker = () => {
    const next = !speakerMuted;
    session.current?.transport?.setSpeakerMuted(next);
    setSpeakerMuted(next);
  };
  const getLevels = useCallback(
    () => session.current?.transport?.getLevels() ?? { input: 0, output: 0 },
    [],
  );
  return {
    status,
    error,
    start,
    end,
    muted,
    speakerMuted,
    startedAt,
    avatarVideo,
    avatarReady,
    phase,
    caption,
    userCaption,
    turns,
    toggleMute,
    toggleSpeaker,
    getLevels,
  };
}
