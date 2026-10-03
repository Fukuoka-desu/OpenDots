export {};

const apiKey = process.env.VOICE_API_KEY;
if (!apiKey) throw new Error('VOICE_API_KEY is required.');

const ttsModel = process.env.VOICE_MODEL || 'eleven_v4_turbo';
const response = await fetch(
  'https://api.elevenlabs.io/v1/convai/agents/create',
  {
    method: 'POST',
    headers: {
      'xi-api-key': apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: 'OpenDots voice',
      conversation_config: {
        agent: {
          first_message: '',
          language: 'ja',
          prompt: {
            prompt:
              'You are an OpenDots voice agent. Follow the current conversation instructions and reply in the user’s language.',
            tools: [
              {
                type: 'client',
                name: 'ask_compute',
                description:
                  'Ask the authorized specialist compute agent to research or reason in this same persistent conversation.',
                expects_response: true,
                parameters: {
                  type: 'object',
                  properties: { request: { type: 'string' } },
                  required: ['request'],
                },
              },
            ],
          },
        },
        tts: { model_id: ttsModel },
      },
      platform_settings: {
        overrides: {
          conversation_config_override: {
            agent: { prompt: { prompt: true } },
            tts: { voice_id: true },
          },
        },
      },
    }),
  },
);

if (!response.ok) {
  const detail = await response.text();
  throw new Error(
    `ElevenLabs agent creation failed (HTTP ${response.status}): ${detail}`,
  );
}

const result: unknown = await response.json();
if (
  !result ||
  typeof result !== 'object' ||
  !('agent_id' in result) ||
  typeof result.agent_id !== 'string'
)
  throw new Error('ElevenLabs did not return an agent ID.');

console.log(result.agent_id);
