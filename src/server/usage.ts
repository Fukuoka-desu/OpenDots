import type { Store } from './store.js';

export type UsageService = 'openai' | 'jev' | 'elevenlabs' | 'search';
export type UsageEvent = {
  id: string;
  at: number;
  service: UsageService;
  model: string;
  threadId?: string;
  runId?: string;
  externalId?: string;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  seconds?: number;
  credits?: number;
  costUsd: number;
  priced: boolean;
  detail?: string;
};

const prices: Record<
  string,
  { input: number; cachedInput: number; output: number }
> = {
  // Sources checked 2026-10-03:
  // https://developers.openai.com/api/docs/models/gpt-5.4-mini
  // https://developers.openai.com/api/docs/models/gpt-5.5
  // https://ai-gateway.vercel.sh/v1/models
  'gpt-5.4-mini': { input: 0.75, cachedInput: 0.075, output: 4.5 },
  'gpt-5.5': { input: 5, cachedInput: 0.5, output: 30 },
  'typesafe-ai/jev': { input: 0.042, cachedInput: 0.042, output: 0 },
  jev: { input: 0.042, cachedInput: 0.042, output: 0 },
  'jev-latest': { input: 0.042, cachedInput: 0.042, output: 0 },
};

export function tokenCost(
  model: string,
  tokens: {
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
  },
): { costUsd: number; priced: boolean } {
  const price = Object.entries(prices).find(
    ([id]) => model === id || model.startsWith(`${id}-`),
  )?.[1];
  if (!price) return { costUsd: 0, priced: false };
  const inputTokens = tokens.inputTokens ?? 0;
  const cachedInputTokens = tokens.cachedInputTokens ?? 0;
  const outputTokens = tokens.outputTokens ?? 0;
  return {
    costUsd:
      ((inputTokens - cachedInputTokens) * price.input +
        cachedInputTokens * price.cachedInput +
        outputTokens * price.output) /
      1_000_000,
    priced: true,
  };
}

const tokyoDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Tokyo',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function tokyoDateParts(at: number) {
  const parts = Object.fromEntries(
    tokyoDateFormatter
      .formatToParts(new Date(at))
      .map((part) => [part.type, part.value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
  };
}

function tokyoDate(at: number) {
  const { year, month, day } = tokyoDateParts(at);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function services() {
  return {
    openai: { usd: 0, count: 0 },
    jev: { usd: 0, count: 0 },
    elevenlabs: { usd: 0, count: 0 },
    search: { usd: 0, count: 0 },
  };
}

function dailyServices() {
  return { openai: 0, jev: 0, elevenlabs: 0, search: 0 };
}

export function usageReport(store: Store, days: number, now = Date.now()) {
  const { year, month, day } = tokyoDateParts(now);
  const firstDay = new Date(Date.UTC(year, month - 1, day - (days - 1)));
  const since =
    Date.UTC(
      firstDay.getUTCFullYear(),
      firstDay.getUTCMonth(),
      firstDay.getUTCDate(),
    ) -
    9 * 60 * 60 * 1000;
  const events = store.listUsage(since, Number.MAX_SAFE_INTEGER);
  const byService = services();
  const daily = Array.from({ length: days }, (_, index) => {
    const date = new Date(Date.UTC(year, month - 1, day - (days - 1) + index))
      .toISOString()
      .slice(0, 10);
    return { date, usd: 0, byService: dailyServices() };
  });
  const dailyByDate = new Map(daily.map((item) => [item.date, item]));
  let totalUsd = 0;
  for (const event of events) {
    totalUsd += event.costUsd;
    byService[event.service].usd += event.costUsd;
    byService[event.service].count++;
    const bucket = dailyByDate.get(tokyoDate(event.at));
    if (bucket) {
      bucket.usd += event.costUsd;
      bucket.byService[event.service] += event.costUsd;
    }
  }
  return {
    since,
    totalUsd,
    byService,
    daily,
    today: {
      usd: daily[daily.length - 1]?.usd ?? 0,
    },
    events: events.slice(0, 200),
    unpriced: [
      ...new Set(
        events.filter((event) => !event.priced).map((event) => event.model),
      ),
    ],
  };
}

export async function syncElevenLabsUsage(
  store: Store,
  config: { apiKey?: string; agentId?: string },
  fetcher: typeof fetch = fetch,
  now = Date.now(),
): Promise<void> {
  const apiKey = config.apiKey;
  const agentId = config.agentId;
  if (!apiKey || !agentId) return;
  if (activeElevenLabsSync) return activeElevenLabsSync;
  if (now - lastElevenLabsSyncAt < 60_000) return;
  lastElevenLabsSyncAt = now;
  activeElevenLabsSync = syncElevenLabsUsageNow(
    store,
    { apiKey, agentId },
    fetcher,
    now,
  ).finally(() => {
    activeElevenLabsSync = undefined;
  });
  return activeElevenLabsSync;
}

let lastElevenLabsSyncAt = Number.NEGATIVE_INFINITY;
let activeElevenLabsSync: Promise<void> | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function stringValue(...values: unknown[]): string | undefined {
  return values.find(
    (value): value is string => typeof value === 'string' && !!value,
  );
}

async function syncElevenLabsUsageNow(
  store: Store,
  config: { apiKey: string; agentId: string },
  fetcher: typeof fetch,
  now: number,
): Promise<void> {
  const signal = AbortSignal.timeout(7_500);
  const cutoff = now - 30 * 24 * 60 * 60 * 1000;
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let done = false;
  try {
    while (!done) {
      signal.throwIfAborted();
      const listUrl = new URL(
        'https://api.elevenlabs.io/v1/convai/conversations',
      );
      listUrl.searchParams.set('agent_id', config.agentId);
      listUrl.searchParams.set('page_size', '100');
      if (cursor) listUrl.searchParams.set('cursor', cursor);
      const listResponse = await fetcher(listUrl, {
        headers: { 'xi-api-key': config.apiKey },
        signal,
      });
      if (!listResponse.ok) throw new Error(`HTTP ${listResponse.status}`);
      const listData: unknown = await listResponse.json();
      if (!isRecord(listData) || !Array.isArray(listData.conversations))
        throw new Error('Invalid conversation list.');
      let hasOlderConversation = false;
      for (const conversation of listData.conversations) {
        if (!isRecord(conversation)) continue;
        const conversationId = stringValue(conversation.conversation_id);
        const startTime = numberValue(conversation.start_time_unix_secs);
        if (startTime !== undefined && startTime * 1000 < cutoff) {
          hasOlderConversation = true;
          continue;
        }
        if (
          conversation.status !== 'done' ||
          !conversationId ||
          store.hasUsageExternalId(conversationId)
        )
          continue;
        signal.throwIfAborted();
        const detailResponse = await fetcher(
          `https://api.elevenlabs.io/v1/convai/conversations/${encodeURIComponent(conversationId)}`,
          {
            headers: { 'xi-api-key': config.apiKey },
            signal,
          },
        );
        if (!detailResponse.ok)
          throw new Error(`HTTP ${detailResponse.status}`);
        const detail: unknown = await detailResponse.json();
        if (!isRecord(detail) || !isRecord(detail.metadata)) continue;
        const metadata = detail.metadata;
        const charging = isRecord(metadata.charging) ? metadata.charging : {};
        const ttsUsage = isRecord(charging.tts_usage) ? charging.tts_usage : {};
        const llmUsage = isRecord(charging.llm_usage) ? charging.llm_usage : {};
        const startTimeUnix = numberValue(detail.start_time_unix_secs);
        const eventAt =
          startTimeUnix !== undefined
            ? startTimeUnix * 1000
            : startTime !== undefined
              ? startTime * 1000
              : undefined;
        if (eventAt === undefined || eventAt < cutoff) continue;
        const llmPrice = numberValue(charging.llm_price) ?? 0;
        const platformPrice = numberValue(charging.platform_price) ?? 0;
        const llmModel = stringValue(
          llmUsage.model,
          llmUsage.model_id,
          charging.llm_model,
        );
        store.addUsage({
          at: eventAt,
          service: 'elevenlabs',
          model: stringValue(ttsUsage.primary_tts_model) ?? 'elevenlabs-agent',
          externalId: conversationId,
          seconds: numberValue(metadata.call_duration_secs),
          credits: numberValue(metadata.cost),
          costUsd:
            Math.round((llmPrice + platformPrice) * 1_000_000_000_000) /
            1_000_000_000_000,
          priced:
            numberValue(charging.llm_price) !== undefined &&
            numberValue(charging.platform_price) !== undefined,
          detail: `LLM ${llmModel ?? 'unknown'} $${llmPrice}`,
        });
      }
      const nextCursor = stringValue(listData.next_cursor);
      if (
        listData.has_more !== true ||
        !nextCursor ||
        seenCursors.has(nextCursor) ||
        hasOlderConversation
      ) {
        done = true;
        break;
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }
  } catch (error) {
    console.warn(
      `ElevenLabs usage sync failed: ${error instanceof Error ? error.name : 'Error'}`,
    );
  }
}
