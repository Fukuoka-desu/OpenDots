import type { WebConfig } from './parallel.js';
import type { SetupStatus } from '../shared/types.js';
export interface PlatformConfig extends WebConfig {
  intelligenceKey?: string;
  intelligenceApiUrl?: string;
  intelligenceWsUrl?: string;
  model?: string;
  judgeKey?: string;
  judgeModel?: string;
  judgeGateway?: boolean;
  heavyModel?: string;
  apiKey?: string;
  baseUrl: string;
  computerSupervisorUrl?: string;
  computerSupervisorToken?: string;
  computerToken?: string;
  computerNamespace?: string;
  browserUrl?: string;
  browserSecret?: string;
  voiceKey?: string;
  voiceModel?: string;
  voiceProvider?: 'openai' | 'gemini' | 'elevenlabs';
  elevenlabsAgentId?: string;
  voiceName?: string;
  slackChannel?: string;
  slackTeam?: string;
  slackUsers: string[];
  slackDotId?: string;
  runtimeUrl: string;
  ownerToken?: string;
}
export function setupStatus(
  config: PlatformConfig,
  slack = 'not_configured',
  activationFailed = false,
): SetupStatus {
  const missing = [
    !config.intelligenceKey && 'INTELLIGENCE_API_KEY',
    !config.apiKey && 'OPENAI_API_KEY',
    !config.model && 'OPENAI_MODEL',
  ].filter((item): item is string => !!item);
  const declaredSlack = !!(
    config.slackChannel &&
    config.slackTeam &&
    config.slackUsers.length
  );
  slack = declaredSlack
    ? activationFailed && slack !== 'online'
      ? 'activation_failed'
      : slack
    : config.slackChannel || config.slackTeam || config.slackUsers.length
      ? 'setup_required'
      : 'not_configured';
  const voiceConfigured =
    !!config.voiceKey &&
    (config.voiceProvider === 'elevenlabs'
      ? !!config.elevenlabsAgentId
      : (config.voiceProvider === 'openai' ||
          config.voiceProvider === 'gemini') &&
        !!config.voiceModel);
  return {
    intelligence: !!config.intelligenceKey,
    model: !!(config.apiKey && config.model),
    judge: !!config.judgeKey,
    browser: !!(config.browserUrl && config.browserSecret),
    voice: voiceConfigured && !missing.length,
    voiceProvider: config.voiceProvider ?? 'openai',
    slack,
    missing,
  };
}
