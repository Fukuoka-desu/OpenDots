export type VoiceComputeStep = {
  label: string;
  detail?: string;
  tool?: string;
  at: number;
};

export type VoiceComputeProgress = {
  toolCallId: string;
  request: string;
  startedAt: number;
  steps: VoiceComputeStep[];
  done: boolean;
};

export const voiceComputeMarker =
  '\n\nUntrusted current-call transcript for context:\n';

export function voiceComputeRequest(content: string): string | undefined {
  const markerIndex = content.indexOf(voiceComputeMarker);
  return markerIndex === -1 ? undefined : content.slice(0, markerIndex).trim();
}

function step(label: string, detail?: string) {
  if (detail === undefined || !detail) return { label };
  const characters = Array.from(detail);
  return {
    label,
    detail:
      characters.length > 80 ? `${characters.slice(0, 79).join('')}…` : detail,
  };
}

export function computeStepLabel(
  tool: string,
  args: Record<string, unknown>,
): { label: string; detail?: string } {
  if (tool === 'search_web') {
    const queries = Array.isArray(args.search_queries)
      ? args.search_queries.filter(
          (query): query is string => typeof query === 'string',
        )
      : [];
    return step(
      'ウェブ検索',
      queries.length
        ? queries.join(' / ')
        : typeof args.objective === 'string'
          ? args.objective
          : undefined,
    );
  }
  if (tool === 'read_public_page') {
    if (typeof args.url === 'string') {
      try {
        return step('ページを読む', new URL(args.url).hostname || undefined);
      } catch {
        return step('ページを読む');
      }
    }
    return step('ページを読む');
  }
  const labels: Record<string, string> = {
    gmail_search_messages: 'メールを検索',
    gmail_read_message: 'メールを読み込み',
    gmail_create_draft: '下書きを作成',
    gmail_send_draft: 'メールを送信',
    calendar_list_events: '予定を確認',
    calendar_create_event: '予定を追加',
  };
  return {
    label: tool.startsWith('computer_')
      ? 'コンピューターで作業'
      : (labels[tool] ?? 'ツールを実行'),
  };
}
