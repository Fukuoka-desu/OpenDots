import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, RefreshCw } from 'lucide-react';
import { api } from './api';
import './usage.css';

type Service = 'openai' | 'jev' | 'elevenlabs' | 'search';
type UsageEvent = {
  id: string;
  at: number;
  service: Service;
  model: string;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  seconds?: number;
  credits?: number;
  costUsd: number;
  priced: boolean;
  detail?: string;
};
type UsageReport = {
  since: number;
  totalUsd: number;
  byService: Record<Service, { usd: number; count: number }>;
  daily: { date: string; usd: number; byService: Record<Service, number> }[];
  today: { usd: number };
  events: UsageEvent[];
  unpriced: string[];
};

const services: { key: Service; label: string; note: string }[] = [
  { key: 'openai', label: 'GPT', note: '会話・作業（OpenAI）' },
  { key: 'elevenlabs', label: 'ElevenLabs', note: '音声通話' },
  { key: 'jev', label: 'Jev', note: '判断・ルーティング' },
  { key: 'search', label: '検索', note: 'Web検索（無料枠）' },
];
const yenPerUsd = 150;
const ranges = [1, 7, 30];

const usd = (value: number) =>
  `$${value < 0.01 && value > 0 ? value.toFixed(4) : value.toFixed(2)}`;
const yen = (value: number) =>
  `約${Math.round(value * yenPerUsd).toLocaleString('ja-JP')}円`;
const time = new Intl.DateTimeFormat('ja-JP', {
  timeZone: 'Asia/Tokyo',
  month: 'numeric',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

function amount(event: UsageEvent) {
  if (event.service === 'elevenlabs')
    return `${Math.round(event.seconds ?? 0)}秒・${event.credits ?? 0}クレジット`;
  if (event.inputTokens !== undefined || event.outputTokens !== undefined)
    return `入力 ${(event.inputTokens ?? 0).toLocaleString()}${
      event.cachedInputTokens
        ? `（キャッシュ ${event.cachedInputTokens.toLocaleString()}）`
        : ''
    } / 出力 ${(event.outputTokens ?? 0).toLocaleString()}`;
  return '1回';
}

export function Usage() {
  const [days, setDays] = useState(30);
  const [report, setReport] = useState<UsageReport>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setReport(await api<UsageReport>(`/usage?days=${days}`));
    } catch (e) {
      setError(e instanceof Error ? e.message : '読み込めませんでした。');
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => {
    void load();
  }, [load]);

  const peak = useMemo(
    () => Math.max(0.0001, ...(report?.daily.map((d) => d.usd) ?? [])),
    [report],
  );

  return (
    <div className="usg">
      <header className="usg-top">
        <a href="/?stage" className="usg-back">
          <ArrowLeft size={16} /> トレタンに戻る
        </a>
        <h1>料金</h1>
        <div className="usg-range" role="group" aria-label="期間">
          {ranges.map((range) => (
            <button
              key={range}
              type="button"
              className={range === days ? 'active' : ''}
              onClick={() => setDays(range)}
            >
              {range === 1 ? '今日' : `${range}日`}
            </button>
          ))}
          <button
            type="button"
            className="usg-reload"
            onClick={() => void load()}
            disabled={loading}
            aria-label="更新"
          >
            <RefreshCw size={14} className={loading ? 'spin' : ''} />
          </button>
        </div>
      </header>

      {error && <p className="usg-error">{error}</p>}
      {!report && !error && <p className="usg-empty">読み込み中…</p>}

      {report && (
        <main className="usg-main">
          <section className="usg-cards">
            <article className="usg-card usg-total">
              <span>{days === 1 ? '今日' : `直近${days}日`}の合計</span>
              <strong>{usd(report.totalUsd)}</strong>
              <small>{yen(report.totalUsd)}</small>
            </article>
            <article className="usg-card">
              <span>今日</span>
              <strong>{usd(report.today.usd)}</strong>
              <small>{yen(report.today.usd)}</small>
            </article>
            {services.map(({ key, label, note }) => (
              <article key={key} className={`usg-card usg-${key}`}>
                <span>
                  <i className="usg-dot" />
                  {label}
                </span>
                <strong>{usd(report.byService[key]?.usd ?? 0)}</strong>
                <small>
                  {note}・{report.byService[key]?.count ?? 0}回
                </small>
              </article>
            ))}
          </section>

          {days > 1 && (
            <section className="usg-panel">
              <h2>日別</h2>
              <div className="usg-chart">
                {report.daily.map((day) => (
                  <div
                    key={day.date}
                    className="usg-col"
                    title={`${day.date} ${usd(day.usd)}`}
                  >
                    <div className="usg-stack">
                      {services.map(({ key }) =>
                        day.byService[key] ? (
                          <i
                            key={key}
                            className={`usg-${key}`}
                            style={{
                              height: `${(day.byService[key] / peak) * 100}%`,
                            }}
                          />
                        ) : null,
                      )}
                    </div>
                    <small>{day.date.slice(5).replace('-', '/')}</small>
                  </div>
                ))}
              </div>
            </section>
          )}

          <section className="usg-panel">
            <h2>明細</h2>
            {report.events.length === 0 ? (
              <p className="usg-empty">まだ記録がありません。</p>
            ) : (
              <table className="usg-table">
                <thead>
                  <tr>
                    <th>日時</th>
                    <th>サービス</th>
                    <th>モデル</th>
                    <th>使用量</th>
                    <th className="num">料金</th>
                  </tr>
                </thead>
                <tbody>
                  {report.events.map((event) => (
                    <tr key={event.id}>
                      <td>{time.format(event.at)}</td>
                      <td>
                        <span className={`usg-tag usg-${event.service}`}>
                          {services.find((s) => s.key === event.service)
                            ?.label ?? event.service}
                        </span>
                      </td>
                      <td className="usg-model">{event.model}</td>
                      <td>{amount(event)}</td>
                      <td className="num">
                        {event.priced ? usd(event.costUsd) : '単価未登録'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <p className="usg-note">
            GPT と Jev
            は使ったトークン数と公式単価から計算しています。ElevenLabs は
            ElevenLabs が通話ごとに出す請求額です。円は 1ドル={yenPerUsd}
            円の概算です。
            {report.unpriced.length > 0 &&
              ` 単価が未登録のモデル: ${report.unpriced.join(', ')}`}
          </p>
        </main>
      )}
    </div>
  );
}
