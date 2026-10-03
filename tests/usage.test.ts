import { afterEach, describe, expect, it, vi } from 'vitest';
import { Judge } from '../src/server/judge.js';
import { Store } from '../src/server/store.js';
import {
  syncElevenLabsUsage,
  tokenCost,
  usageReport,
} from '../src/server/usage.js';
import { usageRoutes } from '../src/server/usage-routes.js';
import type { PlatformConfig } from '../src/server/platform-config.js';

const stores: Store[] = [];
function createStore() {
  const store = new Store(':memory:');
  stores.push(store);
  return store;
}

afterEach(() => {
  stores.splice(0).forEach((store) => store.close());
  vi.restoreAllMocks();
});

describe('usage cost tracking', () => {
  it('prices GPT models with cached tokens and dated snapshots', () => {
    expect(
      tokenCost('gpt-5.4-mini', {
        inputTokens: 1_000_000,
        cachedInputTokens: 300_000,
        outputTokens: 1_000_000,
      }),
    ).toEqual({ costUsd: 5.0475, priced: true });
    expect(
      tokenCost('gpt-5.5', {
        inputTokens: 2_000_000,
        cachedInputTokens: 1_000_000,
        outputTokens: 500_000,
      }),
    ).toEqual({ costUsd: 20.5, priced: true });
    expect(
      tokenCost('gpt-5.4-mini-2026-09-18', {
        inputTokens: 1_000_000,
      }),
    ).toEqual({ costUsd: 0.75, priced: true });
    expect(
      tokenCost('jev-latest', {
        inputTokens: 1_000_000,
        outputTokens: 10_000,
      }),
    ).toEqual({ costUsd: 0.042, priced: true });
  });

  it('marks unknown models as unpriced', () => {
    expect(
      tokenCost('vendor/unknown-model', {
        inputTokens: 100,
        outputTokens: 20,
      }),
    ).toEqual({ costUsd: 0, priced: false });
  });

  it('persists usage newest-first and ignores duplicate external IDs', () => {
    const store = createStore();
    store.addUsage({
      at: 10,
      service: 'elevenlabs',
      model: 'elevenlabs-agent',
      externalId: 'conversation-1',
      costUsd: 0.05,
      priced: true,
    });
    store.addUsage({
      at: 11,
      service: 'elevenlabs',
      model: 'elevenlabs-agent',
      externalId: 'conversation-1',
      costUsd: 0.06,
      priced: true,
    });
    store.addUsage({
      at: 12,
      service: 'search',
      model: 'parallel-search-mcp',
      costUsd: 0,
      priced: true,
    });

    expect(store.hasUsageExternalId('conversation-1')).toBe(true);
    expect(store.hasUsageExternalId('missing')).toBe(false);
    expect(store.listUsage(10)).toMatchObject([
      { at: 12, service: 'search' },
      { at: 10, externalId: 'conversation-1', costUsd: 0.05 },
    ]);
    expect(store.listUsage(10, 1)).toHaveLength(1);
  });

  it('records successful Jev gateway usage through the optional callback', async () => {
    const onUsage = vi.fn();
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            model: 'typesafe-ai/jev',
            usage: { inputTokens: 347, outputTokens: 17 },
            answers: {
              approved: { type: 'boolean', probability: 1 },
            },
          }),
          { headers: { 'Content-Type': 'application/json' } },
        ),
    );
    const judge = new Judge({ judgeKey: 'vck_test', onUsage }, fetcher);

    await judge.ask('Create a draft.', {
      approved: { type: 'noul', instructions: 'Is this requested?' },
    });

    expect(onUsage).toHaveBeenCalledWith({
      model: 'typesafe-ai/jev',
      inputTokens: 347,
      outputTokens: 17,
    });
  });

  it('syncs completed ElevenLabs conversations once and deduplicates on later syncs', async () => {
    const store = createStore();
    const startTime = Math.floor(Date.parse('2026-10-03T16:00:00Z') / 1000);
    const baseTime = Date.parse('2026-10-04T00:00:00Z');
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/v1/convai/conversations')
        return new Response(
          JSON.stringify({
            conversations: [
              {
                conversation_id: 'conversation-1',
                status: 'done',
                start_time_unix_secs: startTime,
              },
              {
                conversation_id: 'conversation-in-progress',
                status: 'in-progress',
                start_time_unix_secs: startTime,
              },
            ],
            has_more: false,
          }),
          { headers: { 'Content-Type': 'application/json' } },
        );
      return new Response(
        JSON.stringify({
          conversation_id: 'conversation-1',
          status: 'done',
          start_time_unix_secs: startTime,
          metadata: {
            call_duration_secs: 90,
            cost: 248,
            charging: {
              llm_price: 0.01562229,
              platform_price: 0.03304407,
              llm_usage: {
                irreversible_generation: {
                  model_usage: {
                    'gpt-4.1-mini': { input: {}, output: {} },
                  },
                },
              },
              tts_usage: { primary_tts_model: 'eleven_turbo_v2_5' },
            },
          },
        }),
        { headers: { 'Content-Type': 'application/json' } },
      );
    });
    const config = { apiKey: 'stubbed-key', agentId: 'stubbed-agent' };

    await syncElevenLabsUsage(store, config, fetcher, baseTime);
    await syncElevenLabsUsage(store, config, fetcher, baseTime + 60_001);

    expect(
      store.listUsage(0).map((event) => ({
        service: event.service,
        model: event.model,
        externalId: event.externalId,
        at: event.at,
        seconds: event.seconds,
        credits: event.credits,
        costUsd: event.costUsd,
        detail: event.detail,
      })),
    ).toEqual([
      {
        service: 'elevenlabs',
        model: 'eleven_turbo_v2_5',
        externalId: 'conversation-1',
        at: startTime * 1000,
        seconds: 90,
        credits: 248,
        costUsd: 0.04866636,
        detail: 'LLM gpt-4.1-mini $0.01562229',
      },
    ]);
    expect(
      fetcher.mock.calls.filter(([url]) =>
        String(url).endsWith('/conversation-1'),
      ),
    ).toHaveLength(1);
  });

  it('buckets daily spend using the Asia/Tokyo date', () => {
    const store = createStore();
    store.addUsage({
      at: Date.parse('2026-10-03T16:00:00Z'),
      service: 'openai',
      model: 'gpt-5.4-mini',
      costUsd: 1.25,
      priced: true,
    });

    const report = usageReport(store, 1, Date.parse('2026-10-04T14:00:00Z'));

    expect(report.daily).toEqual([
      {
        date: '2026-10-04',
        usd: 1.25,
        byService: { openai: 1.25, jev: 0, elevenlabs: 0, search: 0 },
      },
    ]);
    expect(report.today).toEqual({ usd: 1.25 });
  });

  it('returns a bounded usage report from the API route', async () => {
    const store = createStore();
    const config = {
      baseUrl: 'https://api.openai.com/v1',
      slackUsers: [],
      runtimeUrl: 'http://127.0.0.1:4310/api/copilotkit',
    } satisfies PlatformConfig;
    const app = usageRoutes(store, config);

    expect((await app.request('/usage?days=91')).status).toBe(400);
    const response = await app.request('/usage?days=1');

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      totalUsd: 0,
      byService: {
        openai: { usd: 0, count: 0 },
        jev: { usd: 0, count: 0 },
        elevenlabs: { usd: 0, count: 0 },
        search: { usd: 0, count: 0 },
      },
      events: [],
      unpriced: [],
    });
  });
});
