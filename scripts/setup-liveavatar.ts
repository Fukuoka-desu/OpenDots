function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}

const elevenLabsApiKey =
  process.env.ELEVENLABS_API_KEY ?? process.env.VOICE_API_KEY;
const agentId = process.env.ELEVENLABS_AGENT_ID;
const liveAvatarApiKey = process.env.LIVEAVATAR_API_KEY;
const formatsOnly = process.argv.includes('--formats-only');
let secretId: string | undefined;

if (!elevenLabsApiKey)
  throw new Error('ELEVENLABS_API_KEY or VOICE_API_KEY is required.');
if (!agentId) throw new Error('ELEVENLABS_AGENT_ID is required.');
if (!formatsOnly && !liveAvatarApiKey)
  throw new Error('LIVEAVATAR_API_KEY is required.');

if (!formatsOnly) {
  const secretResponse = await fetch('https://api.liveavatar.com/v1/secrets', {
    method: 'POST',
    headers: {
      'X-API-KEY': liveAvatarApiKey!,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      secret_type: 'ELEVENLABS_API_KEY',
      secret_value: elevenLabsApiKey,
      secret_name: 'OpenDots ElevenLabs',
    }),
    redirect: 'error',
  });
  if (!secretResponse.ok)
    throw new Error(
      `LiveAvatar secret creation failed (HTTP ${secretResponse.status}).`,
    );
  const secretPayload: unknown = await secretResponse.json();
  if (
    !isRecord(secretPayload) ||
    !isRecord(secretPayload.data) ||
    typeof secretPayload.data.id !== 'string' ||
    !secretPayload.data.id
  )
    throw new Error('LiveAvatar did not return a secret ID.');
  secretId = secretPayload.data.id;
}

const agentResponse = await fetch(
  `https://api.elevenlabs.io/v1/convai/agents/${encodeURIComponent(agentId)}`,
  {
    method: 'PATCH',
    headers: {
      'xi-api-key': elevenLabsApiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      conversation_config: {
        tts: { agent_output_audio_format: 'pcm_24000' },
        asr: { user_input_audio_format: 'pcm_24000' },
      },
    }),
    redirect: 'error',
  },
);
if (!agentResponse.ok)
  throw new Error(
    `ElevenLabs agent update failed (HTTP ${agentResponse.status}).`,
  );

if (secretId) console.log(secretId);

export {};
