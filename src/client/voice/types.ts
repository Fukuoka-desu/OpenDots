export type VoiceProvider = 'openai' | 'gemini' | 'elevenlabs';
export type VoicePhase = 'listening' | 'speaking' | 'thinking';

export type VoiceCallResponse =
  | { id: string; provider: 'openai'; sdp: string }
  | {
      id: string;
      provider: 'gemini';
      token: string;
      model: string;
      setup: Record<string, unknown>;
    }
  | {
      id: string;
      provider: 'elevenlabs';
      signedUrl: string;
      overrides: {
        agent: { prompt: { prompt: string } };
        tts?: { voiceId: string };
      };
    };

export type VoiceCallbacks = {
  signal: AbortSignal;
  isCancelled: () => boolean;
  onCall: (id: string) => void;
  onActive: () => void;
  onPhase: (phase: VoicePhase) => void;
  onCaption: (text: string) => void;
  onCaptionReset: () => void;
  onUserCaption: (text: string) => void;
  onTranscript: (line: string) => void;
  onError: (message: string) => void;
  onClosed: () => void;
  compute: (toolCallId: string, request: string) => Promise<string>;
};

export type VoiceTransportSession = {
  setMicMuted: (muted: boolean) => void;
  setSpeakerMuted: (muted: boolean) => void;
  getLevels: () => { input: number; output: number };
  close: () => void | Promise<void>;
};
