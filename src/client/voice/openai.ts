import { api } from '../api';
import { createAnalyser, readRms } from './levels';
import type {
  VoiceCallbacks,
  VoiceCallResponse,
  VoiceTransportSession,
} from './types';

export async function connectOpenAI(
  threadId: string,
  stream: MediaStream,
  callbacks: VoiceCallbacks,
): Promise<VoiceTransportSession> {
  const pc = new RTCPeerConnection();
  const audio = new Audio();
  const audioContext = new AudioContext();
  const input = createAnalyser(audioContext, stream);
  let outputAnalyser: AnalyserNode | undefined;
  let remoteSource: MediaStreamAudioSourceNode | undefined;
  let closed = false;
  audio.autoplay = true;
  const channel = pc.createDataChannel('oai-events');
  const close = () => {
    if (closed) return;
    closed = true;
    callbacks.signal.removeEventListener('abort', close);
    input.source.disconnect();
    remoteSource?.disconnect();
    channel.close();
    pc.close();
    audio.pause();
    audio.srcObject = null;
    void audioContext.close();
  };
  callbacks.signal.addEventListener('abort', close, { once: true });
  stream.getTracks().forEach((track) => pc.addTrack(track, stream));
  pc.ontrack = (event) => {
    if (closed) return;
    const remoteStream = event.streams[0] ?? new MediaStream([event.track]);
    audio.srcObject = remoteStream;
    remoteSource?.disconnect();
    const remote = createAnalyser(audioContext, remoteStream);
    remoteSource = remote.source;
    outputAnalyser = remote.analyser;
    void audio.play().catch(() => {
      if (!closed)
        callbacks.onError(
          'Audio playback was blocked. Check your browser audio permissions.',
        );
    });
  };
  pc.onconnectionstatechange = () => {
    if (closed || callbacks.isCancelled()) return;
    if (pc.connectionState === 'connected') callbacks.onActive();
    if (['failed', 'disconnected'].includes(pc.connectionState)) {
      callbacks.onError('The voice connection dropped.');
      callbacks.onClosed();
    }
  };
  channel.onmessage = async (event) => {
    if (closed || callbacks.isCancelled()) return;
    let data: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(String(event.data));
      if (!parsed || typeof parsed !== 'object') return;
      data = parsed as Record<string, unknown>;
    } catch {
      return;
    }
    if (data.type === 'input_audio_buffer.speech_started') {
      callbacks.onPhase('listening');
      callbacks.onCaptionReset();
    }
    if (
      data.type === 'response.output_audio_transcript.delta' &&
      typeof data.delta === 'string'
    ) {
      callbacks.onPhase('speaking');
      callbacks.onCaption(data.delta);
    }
    if (data.type === 'output_audio_buffer.stopped')
      callbacks.onPhase('listening');
    if (data.type === 'response.created') {
      callbacks.onCaptionReset();
      callbacks.onPhase('thinking');
    }
    if (typeof data.transcript === 'string') {
      if (
        data.type === 'conversation.item.input_audio_transcription.completed'
      ) {
        callbacks.onTranscript(`You: ${data.transcript}`);
        callbacks.onUserCaption(data.transcript);
      }
      if (data.type === 'response.output_audio_transcript.done')
        callbacks.onTranscript(`Dot: ${data.transcript}`);
    }
    if (data.type === 'error')
      callbacks.onError(
        'The voice provider reported a session error. End the call and retry.',
      );
    if (
      data.type !== 'response.function_call_arguments.done' ||
      data.name !== 'ask_compute' ||
      typeof data.call_id !== 'string'
    )
      return;
    callbacks.onPhase('thinking');
    let output: string;
    try {
      const args: unknown = JSON.parse(String(data.arguments));
      if (
        !args ||
        typeof args !== 'object' ||
        !('request' in args) ||
        typeof args.request !== 'string'
      )
        throw new Error('Invalid compute request.');
      output = await callbacks.compute(data.call_id, args.request);
    } catch (error) {
      output = `Compute failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
    }
    if (!closed && channel.readyState === 'open') {
      channel.send(
        JSON.stringify({
          type: 'conversation.item.create',
          item: {
            type: 'function_call_output',
            call_id: data.call_id,
            output,
          },
        }),
      );
      channel.send(JSON.stringify({ type: 'response.create' }));
    }
  };
  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const call = await api<VoiceCallResponse>(
      '/voice/calls',
      'POST',
      {
        threadId,
        sdp: offer.sdp,
      },
      callbacks.signal,
    );
    if (call.provider !== 'openai')
      throw new Error('Unexpected voice provider.');
    callbacks.onCall(call.id);
    if (callbacks.isCancelled())
      throw new DOMException('Call cancelled.', 'AbortError');
    await pc.setRemoteDescription({ type: 'answer', sdp: call.sdp });
    await audioContext.resume().catch(() => {});
    return {
      setMicMuted: (muted) =>
        stream.getAudioTracks().forEach((track) => {
          track.enabled = !muted;
        }),
      setSpeakerMuted: (muted) => {
        audio.muted = muted;
      },
      getLevels: () => ({
        input: readRms(input.analyser),
        output: readRms(outputAnalyser),
      }),
      close,
    };
  } catch (error) {
    close();
    throw error;
  }
}
