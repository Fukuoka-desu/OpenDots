import { api } from '../api';
import { createAnalyser, readRms } from './levels';
import type {
  VoiceCallbacks,
  VoiceCallResponse,
  VoiceTransportSession,
} from './types';

const workletSource = `
class PCM16Capture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.position = 0;
    this.samples = new Int16Array(640);
    this.written = 0;
  }
  process(inputs) {
    const input = inputs[0] && inputs[0][0];
    if (!input) return true;
    const step = sampleRate / 16000;
    while (this.position < input.length) {
      const sample = Math.max(-1, Math.min(1, input[Math.floor(this.position)]));
      this.samples[this.written++] = sample < 0 ? sample * 32768 : sample * 32767;
      this.position += step;
      if (this.written === this.samples.length) {
        const buffer = this.samples.buffer;
        this.port.postMessage(buffer, [buffer]);
        this.samples = new Int16Array(640);
        this.written = 0;
      }
    }
    this.position -= input.length;
    return true;
  }
}
registerProcessor('opendots-pcm16-capture', PCM16Capture);
`;

type GeminiServerMessage = {
  setupComplete?: unknown;
  goAway?: unknown;
  error?: unknown;
  toolCall?: {
    functionCalls?: {
      id?: string;
      name: string;
      args?: Record<string, unknown>;
    }[];
  };
  serverContent?: {
    interrupted?: boolean;
    inputTranscription?: { text?: string };
    outputTranscription?: { text?: string };
    modelTurn?: { parts?: { inlineData?: { data?: string } }[] };
    turnComplete?: boolean;
  };
};

function bytesToBase64(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++)
    binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

function decodeBase64(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export async function connectGemini(
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
  if (call.provider !== 'gemini') throw new Error('Unexpected voice provider.');
  callbacks.onCall(call.id);
  if (callbacks.isCancelled())
    throw new DOMException('Call cancelled.', 'AbortError');
  const socket = new WebSocket(
    'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained?access_token=' +
      encodeURIComponent(call.token),
  );
  const audioContext = new AudioContext();
  const input = createAnalyser(audioContext, stream);
  const outputAnalyser = audioContext.createAnalyser();
  outputAnalyser.fftSize = 512;
  const outputGain = audioContext.createGain();
  outputGain.connect(outputAnalyser);
  outputAnalyser.connect(audioContext.destination);
  let nextStartTime = 0;
  let muted = false;
  let closed = false;
  let turnComplete = false;
  let socketOpened = false;
  let inputText = '';
  let outputText = '';
  let incoming = Promise.resolve();
  const sources = new Set<AudioBufferSourceNode>();
  let capture: AudioWorkletNode | undefined;
  let rejectOpen: ((reason?: unknown) => void) | undefined;

  const stopPlayback = () => {
    sources.forEach((source) => {
      source.onended = null;
      try {
        source.stop();
      } catch {
        // The source may already have ended.
      }
    });
    sources.clear();
    nextStartTime = audioContext.currentTime;
  };
  const playbackDrained = () => {
    if (turnComplete && sources.size === 0 && !closed) {
      callbacks.onPhase('listening');
      turnComplete = false;
    }
  };
  const close = () => {
    if (closed) return;
    closed = true;
    callbacks.signal.removeEventListener('abort', onAbort);
    socket.close();
    input.source.disconnect();
    capture?.disconnect();
    stopPlayback();
    void audioContext.close();
  };
  const onAbort = () => {
    rejectOpen?.(new DOMException('Call cancelled.', 'AbortError'));
    close();
  };
  const opened = new Promise<void>((resolve, reject) => {
    rejectOpen = reject;
    socket.onopen = () => {
      if (closed) {
        reject(new DOMException('Call cancelled.', 'AbortError'));
        return;
      }
      socketOpened = true;
      socket.send(JSON.stringify({ setup: call.setup }));
      resolve();
    };
    socket.onerror = () =>
      reject(new Error('Could not connect to Gemini Live.'));
    socket.onmessage = (event) => {
      incoming = incoming.then(async () => {
        if (closed) return;
        const text =
          event.data instanceof Blob
            ? await event.data.text()
            : String(event.data);
        try {
          const parsed: unknown = JSON.parse(text);
          if (parsed && typeof parsed === 'object')
            processMessage(parsed as GeminiServerMessage);
        } catch {
          callbacks.onError('Gemini Live returned an unreadable message.');
        }
      });
    };
    socket.onclose = () => {
      if (closed || callbacks.isCancelled()) return;
      if (!socketOpened) reject(new Error('Gemini Live disconnected.'));
      callbacks.onError('Gemini Live disconnected.');
      callbacks.onClosed();
    };
  });
  callbacks.signal.addEventListener('abort', onAbort, { once: true });
  if (callbacks.signal.aborted) onAbort();
  const playAudio = (base64: string) => {
    const bytes = decodeBase64(base64);
    const sampleCount = Math.floor(bytes.byteLength / 2);
    if (!sampleCount) return;
    const samples = new Float32Array(sampleCount);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let i = 0; i < sampleCount; i++)
      samples[i] = view.getInt16(i * 2, true) / 32768;
    const buffer = audioContext.createBuffer(1, sampleCount, 24_000);
    buffer.copyToChannel(samples, 0);
    const source = audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(outputGain);
    const startAt = Math.max(nextStartTime, audioContext.currentTime);
    source.start(startAt);
    nextStartTime = startAt + buffer.duration;
    sources.add(source);
    source.onended = () => {
      sources.delete(source);
      playbackDrained();
    };
  };
  const saveTurn = () => {
    if (inputText) callbacks.onTranscript(`You: ${inputText}`);
    if (outputText) callbacks.onTranscript(`Dot: ${outputText}`);
    inputText = '';
    outputText = '';
  };
  const processMessage = (data: GeminiServerMessage) => {
    if (closed || callbacks.isCancelled()) return;
    if (data.setupComplete) {
      callbacks.onActive();
      return;
    }
    if (data.goAway) {
      callbacks.onError('Gemini Live ended the voice session.');
      callbacks.onClosed();
      return;
    }
    if (data.error) {
      callbacks.onError('Gemini Live reported a session error.');
      callbacks.onClosed();
      return;
    }
    if (data.toolCall?.functionCalls) {
      callbacks.onPhase('thinking');
      const functionCalls = data.toolCall.functionCalls;
      void Promise.all(
        functionCalls.map(async (functionCall) => {
          if (functionCall.name !== 'ask_compute') return;
          const toolCallId = functionCall.id ?? crypto.randomUUID();
          const request = functionCall.args?.request;
          let result: string;
          try {
            if (typeof request !== 'string')
              throw new Error('Invalid compute request.');
            result = await callbacks.compute(toolCallId, request);
          } catch (error) {
            result = `Compute failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
          }
          if (!closed && socket.readyState === WebSocket.OPEN)
            socket.send(
              JSON.stringify({
                toolResponse: {
                  functionResponses: [
                    {
                      id: toolCallId,
                      name: functionCall.name,
                      response: { result },
                    },
                  ],
                },
              }),
            );
        }),
      );
    }
    const content = data.serverContent;
    if (!content) return;
    if (content.interrupted) {
      stopPlayback();
      callbacks.onPhase('listening');
    }
    const inputTranscription = content.inputTranscription?.text;
    if (typeof inputTranscription === 'string' && inputTranscription) {
      inputText += inputTranscription;
      callbacks.onUserCaption(inputText);
    }
    const outputTranscription = content.outputTranscription?.text;
    if (typeof outputTranscription === 'string' && outputTranscription) {
      outputText += outputTranscription;
      callbacks.onCaption(outputTranscription);
      callbacks.onPhase('speaking');
    }
    const parts = content.modelTurn?.parts ?? [];
    for (const part of parts) {
      const audioData = part.inlineData?.data;
      if (typeof audioData === 'string') playAudio(audioData);
    }
    if (content.turnComplete) {
      saveTurn();
      turnComplete = true;
      playbackDrained();
    }
  };

  try {
    await audioContext.resume().catch(() => {});
    const workletUrl = URL.createObjectURL(
      new Blob([workletSource], { type: 'text/javascript' }),
    );
    try {
      await audioContext.audioWorklet.addModule(workletUrl);
    } finally {
      URL.revokeObjectURL(workletUrl);
    }
    capture = new AudioWorkletNode(audioContext, 'opendots-pcm16-capture', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    capture.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
      if (closed || muted || socket.readyState !== WebSocket.OPEN) return;
      socket.send(
        JSON.stringify({
          realtimeInput: {
            audio: {
              data: bytesToBase64(event.data),
              mimeType: 'audio/pcm;rate=16000',
            },
          },
        }),
      );
    };
    input.source.connect(capture);
    capture.connect(audioContext.destination);
    await opened;
    if (callbacks.signal.aborted || callbacks.isCancelled())
      throw new DOMException('Call cancelled.', 'AbortError');
  } catch (error) {
    close();
    throw error;
  }
  return {
    setMicMuted: (value) => {
      muted = value;
    },
    setSpeakerMuted: (value) => {
      outputGain.gain.setTargetAtTime(
        value ? 0 : 1,
        audioContext.currentTime,
        0.015,
      );
    },
    getLevels: () => ({
      input: readRms(input.analyser),
      output: readRms(outputAnalyser),
    }),
    close,
  };
}
