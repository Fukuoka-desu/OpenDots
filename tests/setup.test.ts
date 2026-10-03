import { expect, it } from 'vitest';
import {
  setupStatus,
  type PlatformConfig,
} from '../src/server/platform-config.js';
const config: PlatformConfig = {
  intelligenceKey: 'fixture',
  apiKey: 'fixture',
  model: 'fixture',
  baseUrl: 'https://example.com',
  runtimeUrl: '',
  voiceName: 'marin',
  slackUsers: [],
};
it('never claims Slack online without a complete managed channel declaration', () => {
  expect(setupStatus(config, 'online').slack).toBe('not_configured');
  expect(
    setupStatus({ ...config, slackChannel: 'support' }, 'online').slack,
  ).toBe('setup_required');
  expect(
    setupStatus(
      {
        ...config,
        slackChannel: 'support',
        slackTeam: 'team',
        slackUsers: ['owner'],
      },
      'online',
    ).slack,
  ).toBe('online');
});
it('requires Intelligence and model setup and disables voice when either is absent', () => {
  expect(
    setupStatus({
      ...config,
      intelligenceKey: '',
      voiceKey: 'fixture',
      voiceModel: 'fixture',
    }),
  ).toMatchObject({ missing: ['INTELLIGENCE_API_KEY'], voice: false });
});
it('checks voice readiness against each selected provider configuration', () => {
  expect(
    setupStatus({
      ...config,
      voiceProvider: 'openai',
      voiceKey: 'fixture',
      voiceModel: 'fixture',
    }),
  ).toMatchObject({ voice: true, voiceProvider: 'openai' });
  expect(
    setupStatus({
      ...config,
      voiceProvider: 'openai',
      voiceKey: 'fixture',
    }).voice,
  ).toBe(false);
  expect(
    setupStatus({
      ...config,
      voiceProvider: 'gemini',
      voiceKey: 'fixture',
      voiceModel: 'fixture',
    }),
  ).toMatchObject({ voice: true, voiceProvider: 'gemini' });
  expect(
    setupStatus({
      ...config,
      voiceProvider: 'elevenlabs',
      voiceKey: 'fixture',
      elevenlabsAgentId: 'agent',
    }),
  ).toMatchObject({ voice: true, voiceProvider: 'elevenlabs' });
  expect(
    setupStatus({
      ...config,
      voiceProvider: 'elevenlabs',
      voiceKey: 'fixture',
    }).voice,
  ).toBe(false);
  expect(
    setupStatus({
      ...config,
      voiceKey: 'fixture',
      voiceModel: 'fixture',
      voiceProvider: undefined,
    }).voice,
  ).toBe(false);
});
it('reports avatar readiness only for complete LiveAvatar ElevenLabs configuration', () => {
  const elevenLabs = {
    ...config,
    voiceProvider: 'elevenlabs' as const,
    voiceKey: 'fixture',
    elevenlabsAgentId: 'agent',
    liveAvatarApiKey: 'liveavatar-key',
    liveAvatarElevenLabsSecretId: 'secret-id',
  };
  expect(
    setupStatus({ ...elevenLabs, liveAvatarAvatarId: 'avatar-id' }).avatar,
  ).toBe(true);
  expect(setupStatus({ ...elevenLabs, liveAvatarSandbox: true }).avatar).toBe(
    true,
  );
  expect(
    setupStatus({ ...elevenLabs, liveAvatarElevenLabsSecretId: undefined })
      .avatar,
  ).toBe(false);
  expect(setupStatus({ ...elevenLabs, voiceProvider: 'openai' }).avatar).toBe(
    false,
  );
});
it('reports whether optional Jev judgments are configured', () => {
  expect(setupStatus(config).judge).toBe(false);
  expect(setupStatus({ ...config, judgeKey: 'fixture' }).judge).toBe(true);
});
it('reports activation failure until the SDK recovers online', () => {
  const declared = {
    ...config,
    slackChannel: 'support',
    slackTeam: 'team',
    slackUsers: ['owner'],
  };
  expect(setupStatus(declared, 'offline', true).slack).toBe(
    'activation_failed',
  );
  expect(setupStatus(declared, 'online', true).slack).toBe('online');
});
