import { afterEach, expect, it, vi } from 'vitest';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { VoiceService, voiceGreeting } from '../src/server/voice.js';
import type { PlatformConfig } from '../src/server/platform-config.js';
import { voiceComputeMarker } from '../src/shared/voice-compute.js';
const resources: (() => void)[] = [];
afterEach(() => {
  resources.splice(0).forEach((close) => close());
  vi.useRealTimers();
});
function fixture(configOverrides: Partial<PlatformConfig> = {}) {
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(':memory:', 'owner');
  workspace.bindThread('thread', workspace.dots()[0].id, 'A conversation');
  resources.push(() => {
    store.close();
    workspace.close();
  });
  const config: PlatformConfig = {
    baseUrl: 'https://example.com',
    voiceKey: 'test-secret',
    voiceModel: 'voice-model',
    voiceName: 'marin',
    runtimeUrl: '',
    slackUsers: [],
    ...configOverrides,
  };
  const turn = vi.fn(
    async (_thread: string, _prompt: string, _signal: AbortSignal) =>
      'Current answer',
  );
  const history = vi.fn(async () => 'user: Earlier topic');
  const transport = vi.fn<typeof fetch>(async (url) =>
    String(url).endsWith('/hangup')
      ? new Response(null, { status: 200 })
      : new Response('v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111', {
          headers: { location: '/v1/realtime/calls/rtc_test' },
        }),
  );
  const voice = new VoiceService(
    {
      workspace,
      store,
      config,
      turn,
      history,
      requireReady() {},
      setup: () => ({
        voice: true,
        avatar:
          config.voiceProvider === 'elevenlabs' &&
          !!config.liveAvatarApiKey &&
          !!config.liveAvatarElevenLabsSecretId &&
          (!!config.liveAvatarAvatarId || !!config.liveAvatarSandbox),
        intelligence: true,
        model: true,
        judge: false,
        browser: false,
        mail: false,
        voiceProvider: 'openai',
        slack: 'not_configured',
        missing: [],
      }),
    },
    transport,
  );
  return { voice, transport, workspace, store, turn, history };
}
const offer = 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111';
it('greets in Japanese based on Tokyo time when there is no upcoming event', () => {
  expect(voiceGreeting(new Date('2026-10-02T23:00:00.000Z'))).toBe(
    'おはようございます。トレタンです。何をしましょうか？',
  );
});
it('announces a same-day event within an hour', () => {
  expect(
    voiceGreeting(new Date('2026-10-03T05:00:00.000Z'), {
      summary: '打ち合わせ',
      start: '2026-10-03T14:30:00+09:00',
    }),
  ).toBe(
    'お疲れさまです。トレタンです。30分後に「打ち合わせ」があります。何をしましょうか？',
  );
});
it('announces a same-day event more than an hour away in Tokyo time', () => {
  expect(
    voiceGreeting(new Date('2026-10-03T05:00:00.000Z'), {
      summary: '予定の確認',
      start: '2026-10-03T16:00:00+09:00',
    }),
  ).toBe(
    'お疲れさまです。トレタンです。次は16:00から「予定の確認」です。何をしましょうか？',
  );
});
it('ignores all-day and next-day events in the greeting', () => {
  const now = new Date('2026-10-03T05:00:00.000Z');
  expect(voiceGreeting(now, { summary: '終日', start: '2026-10-03' })).toBe(
    'お疲れさまです。トレタンです。何をしましょうか？',
  );
  expect(
    voiceGreeting(now, {
      summary: '明日',
      start: '2026-10-04T09:00:00+09:00',
    }),
  ).toBe('お疲れさまです。トレタンです。何をしましょうか？');
});
it('uses the late-night greeting and truncates long event summaries', () => {
  expect(voiceGreeting(new Date('2026-10-03T12:00:00.000Z'))).toMatch(
    /^遅くまでお疲れさまです。/,
  );
  const summary = '予'.repeat(41);
  expect(
    voiceGreeting(new Date('2026-10-03T05:00:00.000Z'), {
      summary,
      start: '2026-10-03T16:00:00+09:00',
    }),
  ).toContain(`「${'予'.repeat(40)}」`);
});
it('binds voice history and compute to the existing thread, deduplicates tools and hangs up remotely', async () => {
  const f = fixture();
  const call = await f.voice.begin(
    'thread',
    offer,
    new AbortController().signal,
  );
  expect(f.history).toHaveBeenCalledWith('thread');
  const body = f.transport.mock.calls[0][1]?.body;
  expect(body).toBeInstanceOf(FormData);
  expect(String((body as FormData).get('session'))).toContain('Earlier topic');
  f.voice.activate(call.id);
  await Promise.all([
    f.voice.compute(call.id, 'tool-1', 'Research'),
    f.voice.compute(call.id, 'tool-1', 'Research'),
  ]);
  expect(f.turn).toHaveBeenCalledTimes(1);
  expect(f.turn.mock.calls[0]?.[0]).toBe('thread');
  await f.voice.end(call.id, 'Confirmed discussion');
  expect(
    f.transport.mock.calls.some(([url]) =>
      String(url).endsWith('/rtc_test/hangup'),
    ),
  ).toBe(true);
  expect(f.workspace.call(call.id).status).toBe('ended');
  expect(f.turn).toHaveBeenLastCalledWith(
    'thread',
    expect.stringContaining('Record a short call receipt'),
    expect.any(AbortSignal),
    { opendotsSource: 'voice_receipt' },
  );
  await expect(f.voice.compute(call.id, 'late', 'Research')).rejects.toThrow(
    'ended',
  );
});
it('declines forbidden voice compute requests without calling the specialist', async () => {
  const f = fixture({ judgeKey: 'judge-secret' });
  f.transport.mockImplementation(async (url) =>
    String(url) === 'https://api.typesafe.ai/v1/systemone'
      ? new Response(
          JSON.stringify({
            answers: { forbidden: { type: 'noul', noul: 0.95 } },
          }),
          { headers: { 'Content-Type': 'application/json' } },
        )
      : String(url).endsWith('/hangup')
        ? new Response(null, { status: 200 })
        : new Response('v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111', {
            headers: { location: '/v1/realtime/calls/rtc_test' },
          }),
  );
  const call = await f.voice.begin(
    'thread',
    offer,
    new AbortController().signal,
  );
  f.voice.activate(call.id);

  await expect(
    f.voice.compute(call.id, 'blocked', 'Send a message.', 'untrusted context'),
  ).resolves.toBe(
    'Declined by the call guardrail: from a voice call I can research and reason, but I cannot send messages, make purchases, change permissions, delete data, or operate your device. Ask in the Dot chat instead.',
  );
  expect(f.turn).not.toHaveBeenCalled();
  const [, init] = f.transport.mock.calls[1]!;
  expect(JSON.parse(String(init?.body))).toMatchObject({
    state: 'Send a message.',
    questions: {
      forbidden: {
        type: 'noul',
        instructions:
          "The request asks the assistant to send a message to someone, make a purchase or payment, change account permissions, delete data, or operate the user's own device.",
      },
    },
  });
  await f.voice.end(call.id, '');
});

it('runs allowed voice compute once with the unchanged request and transcript prompt', async () => {
  const f = fixture({ judgeKey: 'judge-secret' });
  f.transport.mockImplementation(async (url) =>
    String(url) === 'https://api.typesafe.ai/v1/systemone'
      ? new Response(
          JSON.stringify({
            answers: { forbidden: { type: 'noul', noul: 0.1 } },
          }),
          { headers: { 'Content-Type': 'application/json' } },
        )
      : String(url).endsWith('/hangup')
        ? new Response(null, { status: 200 })
        : new Response('v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111', {
            headers: { location: '/v1/realtime/calls/rtc_test' },
          }),
  );
  const call = await f.voice.begin(
    'thread',
    offer,
    new AbortController().signal,
  );
  f.voice.activate(call.id);
  const prompt = `Research this topic.${voiceComputeMarker}The caller mentioned context.`;

  await Promise.all([
    f.voice.compute(
      call.id,
      'allowed',
      'Research this topic.',
      'The caller mentioned context.',
    ),
    f.voice.compute(
      call.id,
      'allowed',
      'Research this topic.',
      'The caller mentioned context.',
    ),
  ]);

  expect(f.turn).toHaveBeenCalledTimes(1);
  expect(f.turn).toHaveBeenCalledWith(
    'thread',
    prompt,
    expect.any(AbortSignal),
  );
  expect(
    f.transport.mock.calls.filter(
      ([url]) => String(url) === 'https://api.typesafe.ai/v1/systemone',
    ),
  ).toHaveLength(1);
  await f.voice.end(call.id, '');
});
it('creates a Gemini Live token with the call setup and returns its setup message', async () => {
  const f = fixture({ voiceProvider: 'gemini', voiceName: 'Kore' });
  f.transport.mockResolvedValueOnce(
    new Response(JSON.stringify({ name: 'auth_tokens/token' }), {
      headers: { 'Content-Type': 'application/json' },
    }),
  );
  const call = await f.voice.begin(
    'thread',
    undefined,
    new AbortController().signal,
  );
  const [url, init] = f.transport.mock.calls[0]!;
  expect(String(url)).toBe(
    'https://generativelanguage.googleapis.com/v1beta/auth_tokens',
  );
  expect(init?.method).toBe('POST');
  expect(new Headers(init?.headers).get('x-goog-api-key')).toBe('test-secret');
  expect(init?.redirect).toBe('error');
  const body = JSON.parse(String(init?.body));
  expect(body.authToken).toMatchObject({
    uses: 1,
    bidiGenerateContentSetup: {
      model: 'models/voice-model',
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } },
        },
      },
      tools: [
        {
          functionDeclarations: [
            {
              name: 'ask_compute',
              parameters: {
                type: 'object',
                properties: { request: { type: 'string' } },
                required: ['request'],
              },
            },
          ],
        },
      ],
      inputAudioTranscription: {},
      outputAudioTranscription: {},
    },
  });
  expect(body.authToken.expireTime).toBeTypeOf('string');
  expect(body.authToken.newSessionExpireTime).toBeTypeOf('string');
  expect(call).toMatchObject({
    id: expect.any(String),
    provider: 'gemini',
    token: 'auth_tokens/token',
    model: 'voice-model',
    setup: {
      model: 'models/voice-model',
      systemInstruction: {
        parts: [
          { text: expect.stringContaining("Reply in the user's language.") },
        ],
      },
    },
  });
});
it('creates an ElevenLabs signed URL and returns conversation overrides', async () => {
  const f = fixture({
    voiceProvider: 'elevenlabs',
    elevenlabsAgentId: 'agent-id',
    voiceName: 'voice-id',
  });
  f.transport.mockResolvedValueOnce(
    new Response(
      JSON.stringify({ signed_url: 'wss://signed.example/session' }),
      {
        headers: { 'Content-Type': 'application/json' },
      },
    ),
  );
  const call = await f.voice.begin(
    'thread',
    undefined,
    new AbortController().signal,
  );
  const [url, init] = f.transport.mock.calls[0]!;
  expect(String(url)).toBe(
    'https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=agent-id',
  );
  expect(new Headers(init?.headers).get('xi-api-key')).toBe('test-secret');
  expect(init?.redirect).toBe('error');
  expect(call).toMatchObject({
    provider: 'elevenlabs',
    signedUrl: 'wss://signed.example/session',
    overrides: {
      agent: {
        prompt: {
          prompt: expect.stringContaining("Reply in the user's language."),
        },
        firstMessage: expect.stringMatching(
          /^(?:おはようございます。|お疲れさまです。|遅くまでお疲れさまです。)トレタンです。/,
        ),
      },
      tts: { voiceId: 'voice-id' },
    },
  });
});
it('creates a LiveAvatar LITE session token for the ElevenLabs agent', async () => {
  const f = fixture({
    voiceProvider: 'elevenlabs',
    elevenlabsAgentId: 'agent-id',
    voiceName: 'voice-id',
    liveAvatarApiKey: 'liveavatar-secret',
    liveAvatarAvatarId: 'avatar-id',
    liveAvatarElevenLabsSecretId: 'elevenlabs-secret-id',
  });
  f.transport.mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        code: 100,
        data: { session_id: 'session-id', session_token: 'session-token' },
        message: 'success',
      }),
      { headers: { 'Content-Type': 'application/json' } },
    ),
  );

  const call = await f.voice.begin(
    'thread',
    undefined,
    new AbortController().signal,
  );
  const [url, init] = f.transport.mock.calls[0]!;

  expect(String(url)).toBe('https://api.liveavatar.com/v1/sessions/token');
  expect(init?.method).toBe('POST');
  expect(new Headers(init?.headers).get('X-API-KEY')).toBe('liveavatar-secret');
  expect(init?.redirect).toBe('error');
  expect(JSON.parse(String(init?.body))).toEqual({
    mode: 'LITE',
    avatar_id: 'avatar-id',
    elevenlabs_agent_config: {
      secret_id: 'elevenlabs-secret-id',
      agent_id: 'agent-id',
      voice_id: 'voice-id',
    },
  });
  expect(call).toMatchObject({
    id: expect.any(String),
    provider: 'elevenlabs',
    avatar: { sessionToken: 'session-token' },
    context: expect.stringContaining("Reply in the user's language."),
  });
});
it('forces the LiveAvatar sandbox avatar and flag', async () => {
  const f = fixture({
    voiceProvider: 'elevenlabs',
    elevenlabsAgentId: 'agent-id',
    liveAvatarApiKey: 'liveavatar-secret',
    liveAvatarAvatarId: 'ignored-avatar-id',
    liveAvatarElevenLabsSecretId: 'elevenlabs-secret-id',
    liveAvatarSandbox: true,
  });
  f.transport.mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        code: 100,
        data: { session_id: 'session-id', session_token: 'session-token' },
        message: 'success',
      }),
      { headers: { 'Content-Type': 'application/json' } },
    ),
  );

  await f.voice.begin('thread', undefined, new AbortController().signal);

  const [, init] = f.transport.mock.calls[0]!;
  expect(JSON.parse(String(init?.body))).toMatchObject({
    mode: 'LITE',
    avatar_id: 'dd73ea75-1218-4ef3-92ce-606d5f7fbc0a',
    is_sandbox: true,
    elevenlabs_agent_config: {
      secret_id: 'elevenlabs-secret-id',
      agent_id: 'agent-id',
    },
  });
});
it('rejects LiveAvatar session-token responses without the documented data envelope', async () => {
  const f = fixture({
    voiceProvider: 'elevenlabs',
    elevenlabsAgentId: 'agent-id',
    liveAvatarApiKey: 'liveavatar-secret',
    liveAvatarAvatarId: 'avatar-id',
    liveAvatarElevenLabsSecretId: 'elevenlabs-secret-id',
  });
  f.transport.mockResolvedValueOnce(
    new Response(JSON.stringify({ session_token: 'session-token' }), {
      headers: { 'Content-Type': 'application/json' },
    }),
  );

  await expect(
    f.voice.begin('thread', undefined, new AbortController().signal),
  ).rejects.toThrow('Voice provider returned an invalid session token.');
  expect(f.workspace.calls()[0].status).toBe('failed');
});
it('requires an SDP offer for OpenAI before contacting the provider', async () => {
  const f = fixture({ voiceProvider: 'openai' });
  await expect(
    f.voice.begin('thread', undefined, new AbortController().signal),
  ).rejects.toThrow('SDP offer is required');
  expect(f.transport).not.toHaveBeenCalled();
});
it('rejects unowned threads before provider contact and expires unactivated peers', async () => {
  vi.useFakeTimers();
  const f = fixture();
  await expect(
    f.voice.begin('foreign', offer, new AbortController().signal),
  ).rejects.toThrow();
  expect(f.transport).not.toHaveBeenCalled();
  const call = await f.voice.begin(
    'thread',
    offer,
    new AbortController().signal,
  );
  await vi.advanceTimersByTimeAsync(30_001);
  expect(f.workspace.call(call.id).status).toBe('failed');
  expect(
    f.transport.mock.calls.some(([url]) => String(url).endsWith('/hangup')),
  ).toBe(true);
});
it('aborts a pending history lookup without starting a provider session', async () => {
  const f = fixture();
  f.history.mockImplementation(() => new Promise(() => {}));
  const controller = new AbortController();
  const pending = f.voice.begin('thread', offer, controller.signal);
  controller.abort();
  await expect(pending).rejects.toThrow('cancelled');
  expect(f.transport).not.toHaveBeenCalled();
});
it('fails visibly for provider errors and does not claim an active call', async () => {
  const f = fixture();
  f.transport.mockResolvedValue(
    new Response('provider error', { status: 429 }),
  );
  await expect(
    f.voice.begin('thread', offer, new AbortController().signal),
  ).rejects.toThrow('429');
  expect(f.workspace.calls()[0].status).toBe('failed');
});
it('hangs up a provisioned peer whose SDP is invalid', async () => {
  const f = fixture();
  f.transport.mockResolvedValueOnce(
    new Response('invalid SDP', {
      headers: { location: '/v1/realtime/calls/rtc_test' },
    }),
  );
  await expect(
    f.voice.begin('thread', offer, new AbortController().signal),
  ).rejects.toThrow('invalid SDP');
  expect(
    f.transport.mock.calls.some(([url]) =>
      String(url).endsWith('/rtc_test/hangup'),
    ),
  ).toBe(true);
});
it('saves a late transcript after expiry without changing the ended status or duration', async () => {
  vi.useFakeTimers();
  const f = fixture();
  const call = await f.voice.begin(
    'thread',
    offer,
    new AbortController().signal,
  );
  await vi.advanceTimersByTimeAsync(30_001);
  const expired = f.workspace.call(call.id);
  await f.voice.end(call.id, 'Buffered speech at disconnect');
  await f.voice.end(call.id, 'Buffered speech at disconnect');
  expect(f.workspace.call(call.id)).toMatchObject({
    status: 'failed',
    endedAt: expired.endedAt,
    transcript: 'Buffered speech at disconnect',
  });
  expect(f.turn).toHaveBeenCalledTimes(1);
});
it('defers paused transcript synchronization and resumes it once without a duplicate turn', async () => {
  const f = fixture();
  const call = await f.voice.begin(
    'thread',
    offer,
    new AbortController().signal,
  );
  f.store.updateSettings({ paused: true });
  f.voice.abortAll();
  await f.voice.end(call.id, 'Speech saved while paused');
  expect(f.turn).not.toHaveBeenCalled();
  expect(f.workspace.call(call.id).transcript).toBe(
    'Speech saved while paused',
  );
  expect(f.workspace.call(call.id).error).toContain(
    'pending Intelligence sync',
  );
  f.store.updateSettings({ paused: false });
  await f.voice.resumePending();
  await f.voice.resumePending();
  expect(f.turn).toHaveBeenCalledTimes(1);
  expect(f.workspace.call(call.id).status).toBe('failed');
});

it('reports rejected provider hangup status without exposing its response body', async () => {
  const f = fixture();
  const call = await f.voice.begin(
    'thread',
    offer,
    new AbortController().signal,
  );
  f.transport.mockResolvedValueOnce(
    new Response('sensitive provider details', { status: 409 }),
  );
  const ended = await f.voice.end(call.id, 'Confirmed discussion');
  expect(ended.status).toBe('ended');
  expect(ended.error).toContain('HTTP 409');
  expect(ended.error).not.toContain('sensitive provider details');
});
it('reports transport hangup failures without exposing transport errors', async () => {
  const f = fixture();
  const call = await f.voice.begin(
    'thread',
    offer,
    new AbortController().signal,
  );
  f.transport.mockRejectedValueOnce(new Error('sensitive transport details'));
  const ended = await f.voice.end(call.id, 'Confirmed discussion');
  expect(ended.error).toBe(
    'The local call stopped, but provider hangup failed (Error).',
  );
});

it('distinguishes provider hangup timeout from transport failure', async () => {
  const f = fixture();
  const call = await f.voice.begin(
    'thread',
    offer,
    new AbortController().signal,
  );
  f.transport.mockRejectedValueOnce(
    new DOMException('sensitive timeout details', 'TimeoutError'),
  );
  const ended = await f.voice.end(call.id, 'Confirmed discussion');
  expect(ended.error).toBe(
    'The local call stopped, but provider hangup timed out.',
  );
});
it('sanitizes custom provider transport error names', async () => {
  const f = fixture();
  const call = await f.voice.begin(
    'thread',
    offer,
    new AbortController().signal,
  );
  const error = new Error('sensitive transport details');
  error.name = 'sensitive provider identifier';
  f.transport.mockRejectedValueOnce(error);
  const ended = await f.voice.end(call.id, 'Confirmed discussion');
  expect(ended.error).toBe(
    'The local call stopped, but provider hangup failed (transport error).',
  );
});
