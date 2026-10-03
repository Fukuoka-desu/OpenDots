import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  CopilotKitProvider,
  useAgent,
  useCopilotKit,
} from '@copilotkit/react-core/v2';
import type { Message, ToolCall } from '@ag-ui/core';
import {
  AudioLines,
  BookOpen,
  Brain,
  CalendarDays,
  CircleCheck,
  Database,
  FileText,
  Globe,
  House,
  LoaderCircle,
  Mail,
  MessageCircle,
  Mic,
  MicOff,
  Phone,
  PhoneOff,
  Plus,
  SendHorizontal,
  Settings,
  SquareCheck,
  SquareTerminal,
  User,
  Users,
  Wrench,
} from 'lucide-react';
import { api, authHeaders } from './api';
import type { AudioLevels, LiveDotPhase } from './LiveDot';
import { isInternalVoiceReceipt } from './ChatTranscript';
import { useVoice } from './useVoice';
import { startChromaKey } from './chromaKey';
import { VoiceWave } from './VoiceWave';
import type {
  Conversation,
  Dot,
  SetupStatus,
  WorkspaceState,
} from '../shared/types';
import './stage.css';

const dotKey = 'opendots-stage-dot';
const message = (e: unknown, fallback: string) =>
  e instanceof Error ? e.message : fallback;
const clock = new Intl.DateTimeFormat('ja-JP', {
  hour: '2-digit',
  minute: '2-digit',
});

type ActionKind =
  'code' | 'calendar' | 'mail' | 'browser' | 'crm' | 'memo' | 'other';
const actions: Record<
  ActionKind,
  { icon: ReactNode; name: string; base: string; busy: string }
> = {
  code: {
    icon: <SquareTerminal size={20} />,
    name: 'コード',
    base: 'コードを実行',
    busy: '実行中',
  },
  calendar: {
    icon: <CalendarDays size={20} />,
    name: 'カレンダー',
    base: 'カレンダーを確認',
    busy: '確認中',
  },
  mail: {
    icon: <Mail size={20} />,
    name: 'メール',
    base: 'メールを作成',
    busy: '下書き中',
  },
  browser: {
    icon: <Globe size={20} />,
    name: 'ブラウザ',
    base: 'ブラウザで情報収集',
    busy: '情報収集中',
  },
  crm: {
    icon: <Users size={20} />,
    name: 'CRM',
    base: 'CRMを更新',
    busy: '更新中',
  },
  memo: {
    icon: <FileText size={20} />,
    name: '議事メモ',
    base: 'メモを作成',
    busy: '準備中',
  },
  other: {
    icon: <Wrench size={20} />,
    name: 'ツール',
    base: '',
    busy: '実行中',
  },
};
const dockKinds: ActionKind[] = ['code', 'mail', 'browser', 'memo', 'calendar'];

function kindOf(tool: string): ActionKind {
  if (/computer_(exec|files)|shell|terminal|code/i.test(tool)) return 'code';
  if (/calendar|schedule|event|meeting/i.test(tool)) return 'calendar';
  if (/mail|gmail|slack|send_message|reply/i.test(tool)) return 'mail';
  if (/crm|hubspot|salesforce|contact|deal|lead/i.test(tool)) return 'crm';
  if (/page|note|memo|doc|minutes|summary/i.test(tool)) return 'memo';
  if (/computer_|browser|web|search|fetch|research|compute/i.test(tool))
    return 'browser';
  return 'other';
}

function detail(args: string) {
  try {
    const value = JSON.parse(args) as Record<string, unknown>;
    const pick =
      ['command', 'path', 'url', 'query', 'title', 'text', 'request', 'subject']
        .map((key) => value[key])
        .find((item) => typeof item === 'string' && item) ??
      Object.values(value).find((item) => typeof item === 'string' && item);
    return typeof pick === 'string' ? pick.slice(0, 48) : '';
  } catch {
    return '';
  }
}

/** Remembers when each message first appeared, since messages carry no time. */
function useSeenAt() {
  const seen = useRef(new Map<string, number>());
  return (id: string) => {
    if (!seen.current.has(id)) seen.current.set(id, Date.now());
    return clock.format(seen.current.get(id));
  };
}

function useLevelVars(
  ref: React.RefObject<HTMLDivElement | null>,
  getLevels: () => AudioLevels,
) {
  useEffect(() => {
    let frame = 0;
    const tick = () => {
      const { input, output } = getLevels();
      ref.current?.style.setProperty('--in', input.toFixed(3));
      ref.current?.style.setProperty('--out', output.toFixed(3));
      frame = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(frame);
  }, [ref, getLevels]);
}

/** Full-screen AI secretary view for talking with one Dot. */
export function Stage() {
  const [state, setState] = useState<WorkspaceState>();
  const [error, setError] = useState('');
  const [dotId, setDotId] = useState(() => localStorage.getItem(dotKey) ?? '');
  const [thread, setThread] = useState<Conversation>();
  const creating = useRef('');
  useEffect(() => {
    api<WorkspaceState>('/workspace')
      .then(setState)
      .catch((e) =>
        setError(message(e, 'ワークスペースを読み込めませんでした。')),
      );
  }, []);
  const dot = state?.dots.find((item) => item.id === dotId) ?? state?.dots[0];
  const newThread = async (target: Dot) => {
    if (creating.current === target.id) return;
    creating.current = target.id;
    try {
      setThread(
        await api<Conversation>('/conversations', 'POST', {
          dotId: target.id,
          title: 'AI秘書との会話',
        }),
      );
    } catch (e) {
      setError(message(e, '会話を作成できませんでした。'));
    } finally {
      creating.current = '';
    }
  };
  useEffect(() => {
    if (!state || !dot) return;
    localStorage.setItem(dotKey, dot.id);
    const latest = state.conversations
      .filter((item) => item.dotId === dot.id)
      .sort((a, b) => b.createdAt - a.createdAt)[0];
    if (latest) setThread(latest);
    else void newThread(dot);
  }, [state, dot?.id]);
  const ready = state?.setup.intelligence && state.setup.model;
  if (!state || !dot || !thread || !ready)
    return (
      <div className="sec sec-empty">
        <span className="sec-empty-face sec-ai-icon">
          <AudioLines size={44} />
        </span>
        <p role={error ? 'alert' : 'status'}>
          {error ||
            (state && !ready
              ? `セットアップが必要です: ${state.setup.missing.join(', ')}`
              : state && !state.dots.length
                ? 'Dot がまだありません。ワークスペースで作成してください。'
                : 'AI秘書を呼んでいます…')}
        </p>
        <a href="/">ワークスペースを開く</a>
      </div>
    );
  return (
    <CopilotKitProvider runtimeUrl="/api/copilotkit" headers={authHeaders()}>
      <StageRoom
        key={thread.id}
        dot={dot}
        dots={state.dots}
        thread={thread}
        setup={state.setup}
        onDot={setDotId}
        onNew={() => void newThread(dot)}
      />
    </CopilotKitProvider>
  );
}

function Rail() {
  const items: [ReactNode, string][] = [
    [<House key="h" />, 'ホーム'],
    [<MessageCircle key="c" />, 'チャット'],
    [<CalendarDays key="s" />, 'スケジュール'],
    [<Mail key="m" />, 'メール'],
    [<SquareCheck key="t" />, 'タスク'],
    [<Users key="r" />, 'CRM'],
    [<Globe key="b" />, 'ブラウザ'],
    [<BookOpen key="k" />, 'ナレッジ'],
  ];
  return (
    <nav className="sec-rail" aria-label="メニュー">
      <span className="sec-logo">
        <span className="sec-logo-mark" />
        Jev
      </span>
      {items.map(([icon, label], i) => (
        <a
          key={label}
          className={`sec-rail-item ${i === 0 ? 'active' : ''}`}
          href={i === 0 ? '/?stage' : '/'}
          aria-current={i === 0 ? 'page' : undefined}
        >
          {icon}
          <span>{label}</span>
        </a>
      ))}
      <a className="sec-rail-item sec-rail-end" href="/">
        <Settings />
        <span>設定</span>
      </a>
    </nav>
  );
}

function Bars({ count, className }: { count: number; className: string }) {
  return (
    <span className={className} aria-hidden>
      {Array.from({ length: count }, (_, i) => (
        <i key={i} style={{ '--i': i } as React.CSSProperties} />
      ))}
    </span>
  );
}

function StageRoom({
  dot,
  dots,
  thread,
  setup,
  onDot,
  onNew,
}: {
  dot: Dot;
  dots: Dot[];
  thread: Conversation;
  setup: SetupStatus;
  onDot: (id: string) => void;
  onNew: () => void;
}) {
  const { agent, isReady } = useAgent({
    agentId: `stage-${thread.id}`,
    runtimeAgentId: dot.id,
    threadId: thread.id,
  });
  const { copilotkit } = useCopilotKit();
  const [loaded, setLoaded] = useState(false);
  const [running, setRunning] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const root = useRef<HTMLDivElement>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const seenAt = useSeenAt();
  const voice = useVoice(
    thread.id,
    () => {},
    setup.voiceProvider,
    agent.messages.at(-1)?.id,
  );
  useLevelVars(root, voice.getLevels);
  const keyCanvas = useRef<HTMLCanvasElement>(null);
  const sourceVideo = useRef<HTMLVideoElement | null>(null);
  const { avatarVideo: attachAvatarVideo, avatarReady } = voice;
  const avatarVideo = useCallback(
    (element: HTMLVideoElement | null) => {
      sourceVideo.current = element;
      attachAvatarVideo(element);
    },
    [attachAvatarVideo],
  );
  useEffect(() => {
    const video = sourceVideo.current;
    const canvas = keyCanvas.current;
    if (!avatarReady || !video || !canvas) return;
    const stop = startChromaKey(video, canvas);
    video.classList.toggle('raw', !stop);
    return stop;
  }, [avatarReady]);
  useEffect(() => {
    const events = agent.subscribe({
      onRunErrorEvent: ({ event }) => setError(event.message),
    });
    return () => events.unsubscribe();
  }, [agent]);
  useEffect(() => {
    if (!isReady) return;
    let active = true;
    void copilotkit
      .connectAgent({ agent })
      .then(() => active && setLoaded(true))
      .catch(
        (e) => active && setError(message(e, '会話に接続できませんでした。')),
      );
    return () => {
      active = false;
    };
  }, [agent, copilotkit, isReady]);

  const finished = new Set(
    agent.messages.flatMap((item) =>
      item.role === 'tool' ? [item.toolCallId] : [],
    ),
  );
  const calls = agent.messages.flatMap((item) =>
    item.role === 'assistant' ? (item.toolCalls ?? []) : [],
  );
  const onCall = voice.status !== 'idle';
  const working = running || voice.status === 'active';
  const callState = (call: ToolCall) =>
    finished.has(call.id) ? 'done' : working ? 'busy' : 'stopped';
  const dockState = (kind: ActionKind) => {
    const mine = calls.filter((call) => kindOf(call.function.name) === kind);
    if (mine.some((call) => callState(call) === 'busy')) return 'busy';
    return mine.length && callState(mine.at(-1)!) === 'done' ? 'done' : 'idle';
  };
  const lines = agent.messages.filter(
    (item, index, all): item is Message =>
      !isInternalVoiceReceipt(item) &&
      !(index > 0 && isInternalVoiceReceipt(all[index - 1])) &&
      ((item.role === 'user' &&
        typeof item.content === 'string' &&
        !!item.content.trim()) ||
        (item.role === 'assistant' &&
          ((typeof item.content === 'string' && !!item.content.trim()) ||
            !!item.toolCalls?.length))),
  );
  const live = voice.status === 'active';
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [lines.length, running, voice.turns.length, voice.phase]);

  const send = async () => {
    const text = draft.trim();
    if (!text || running || !loaded) return;
    setError('');
    setDraft('');
    setRunning(true);
    agent.addMessage({ id: crypto.randomUUID(), role: 'user', content: text });
    try {
      await copilotkit.runAgent({ agent });
    } catch (e) {
      setError(message(e, '返事を取得できませんでした。'));
    } finally {
      setRunning(false);
    }
  };
  const phase: LiveDotPhase =
    voice.status === 'connecting'
      ? 'connecting'
      : live
        ? voice.phase
        : running
          ? 'thinking'
          : 'idle';
  const label = {
    idle: loaded ? 'タップして話す' : '接続しています…',
    connecting: 'つないでいます…',
    listening: voice.muted ? 'ミュート中' : '聞いています…',
    thinking: '考えています…',
    speaking: 'AIが話しています…',
  }[phase];
  const voiceName =
    setup.voiceProvider === 'elevenlabs'
      ? 'ElevenLabs'
      : setup.voiceProvider === 'gemini'
        ? 'Gemini Live'
        : 'OpenAI Realtime';

  return (
    <div ref={root} className={`sec phase-${phase}`}>
      <Rail />
      <header className="sec-top">
        <span>考え、動き、つながる —— あなたのAI秘書</span>
        <span className="sec-top-tools">
          <select
            aria-label="話す Dot"
            value={dot.id}
            disabled={onCall}
            onChange={(e) => onDot(e.target.value)}
          >
            {dots.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
          <button onClick={onNew} disabled={onCall || running}>
            <Plus size={14} /> 新しい会話
          </button>
        </span>
      </header>

      <section
        className={`sec-stage ${voice.avatarReady ? 'avatar-on' : ''}`}
        aria-label="AI秘書"
      >
        <VoiceWave phase={phase} getLevels={voice.getLevels} />
        <video
          className={`sec-video sec-source ${voice.avatarReady ? 'ready' : ''}`}
          ref={avatarVideo}
          autoPlay
          playsInline
        />
        <canvas
          className={`sec-video sec-keyed ${voice.avatarReady ? 'ready' : ''}`}
          ref={keyCanvas}
          aria-hidden
        />
        <div className="sec-glow" aria-hidden />
        <div className="sec-badge">
          <p>
            <span className={`sec-live-dot ${onCall ? 'on' : ''}`} />
            <strong>AI秘書</strong>
            <em className={onCall ? 'on' : ''}>
              {onCall ? 'LIVE' : 'STANDBY'}
            </em>
          </p>
          <small>Jevが判断する、あなただけのAI秘書</small>
        </div>
        <div className="sec-actions">
          <h3>実行中のアクション</h3>
          <ul>
            {dockKinds.map((kind) => {
              const status = dockState(kind);
              return (
                <li key={kind} className={status}>
                  {actions[kind].icon}
                  <span>
                    <i />
                    {actions[kind].name}
                  </span>
                  <small>
                    {status === 'busy'
                      ? actions[kind].busy
                      : status === 'done'
                        ? '完了'
                        : '待機中'}
                  </small>
                </li>
              );
            })}
          </ul>
        </div>
        <div className="sec-controls">
          <button
            className="sec-ctl"
            aria-label={voice.muted ? 'マイクをオン' : 'マイクをミュート'}
            aria-pressed={voice.muted}
            disabled={!live}
            onClick={voice.toggleMute}
          >
            <span>{voice.muted ? <MicOff /> : <Mic />}</span>
            ミュート
          </button>
          <button
            className="sec-orb"
            aria-label={onCall ? label : '通話を開始'}
            disabled={
              onCall || !setup.voice || !loaded || voice.status === 'ending'
            }
            title={setup.voice ? undefined : '音声の設定がまだです'}
            onClick={() => void voice.start()}
          >
            <span className="sec-orb-ring">
              {onCall ? (
                <Bars count={7} className="sec-orb-bars" />
              ) : (
                <Phone size={34} />
              )}
            </span>
            <span className="sec-orb-label" role="status">
              {label}
            </span>
          </button>
          <button
            className="sec-ctl end"
            aria-label="通話を終了"
            disabled={!onCall || voice.status === 'ending'}
            onClick={() => void voice.end()}
          >
            <span>
              <PhoneOff />
            </span>
            終了
          </button>
          <Bars count={9} className="sec-wave" />
        </div>
      </section>

      <aside className="sec-chat" aria-label="会話">
        <header className="sec-chat-head">
          <span className="sec-chat-icon">
            <AudioLines />
          </span>
          <span>
            <h2>AI秘書</h2>
            <small>Jevが判断 / Voice Agent</small>
          </span>
          <dl className="sec-stack">
            <dt>
              <Brain size={14} /> Brain:
            </dt>
            <dd className={setup.judge ? 'ok' : ''}>
              Jev{setup.model ? ' + GPT' : ''}
            </dd>
            <dt>
              <AudioLines size={14} /> Voice:
            </dt>
            <dd className={setup.voice ? 'ok' : ''}>OpenDots / {voiceName}</dd>
            <dt>
              <Database size={14} /> Action:
            </dt>
            <dd className={setup.browser ? 'ok' : ''}>Browser / Tools</dd>
          </dl>
        </header>
        <div className="sec-log">
          {!lines.length && !live && (
            <p className="sec-hint">
              中央のボタンで声で話すか、下の欄に文字で話しかけてください。
            </p>
          )}
          {lines.map((item) =>
            item.role === 'user' ? (
              <div key={item.id} className="sec-msg you">
                <p className="sec-meta">
                  <span className="sec-you-icon">
                    <User size={14} />
                  </span>
                  あなた <time>{seenAt(item.id)}</time>
                </p>
                <p className="sec-bubble">{String(item.content)}</p>
              </div>
            ) : (
              <div key={item.id} className="sec-msg ai">
                <span className="sec-ai-icon">
                  <AudioLines size={16} />
                </span>
                <div>
                  <p className="sec-meta">
                    AI秘書 <time>{seenAt(item.id)}</time>
                  </p>
                  {typeof item.content === 'string' && item.content.trim() && (
                    <p className="sec-bubble">{item.content}</p>
                  )}
                  {item.role === 'assistant' && !!item.toolCalls?.length && (
                    <ul className="sec-tasks">
                      {item.toolCalls.map((call) => {
                        const kind = kindOf(call.function.name);
                        const status = callState(call);
                        const base =
                          actions[kind].base || `${call.function.name} を実行`;
                        return (
                          <li key={call.id} className={status}>
                            <span className="sec-task-icon">
                              {actions[kind].icon}
                            </span>
                            <span>
                              <strong>
                                {status === 'done'
                                  ? `${base}しました`
                                  : status === 'busy'
                                    ? `${base}中…`
                                    : `${base}（中断）`}
                              </strong>
                              <small>
                                {detail(call.function.arguments) ||
                                  call.function.name}
                              </small>
                            </span>
                            {status === 'done' ? (
                              <CircleCheck className="sec-check" size={20} />
                            ) : status === 'busy' ? (
                              <LoaderCircle className="sec-spin" size={20} />
                            ) : (
                              <span />
                            )}
                            <time>{seenAt(call.id)}</time>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              </div>
            ),
          )}
          {voice.turns.map((turn) =>
            turn.role === 'you' ? (
              <div key={`turn-${turn.id}`} className="sec-msg you voice">
                <p className="sec-meta">
                  <span className="sec-you-icon">
                    <Mic size={13} />
                  </span>
                  あなた（音声）
                </p>
                <p className="sec-bubble">{turn.text}</p>
              </div>
            ) : (
              <div key={`turn-${turn.id}`} className="sec-msg ai voice">
                <span className="sec-ai-icon">
                  <AudioLines size={16} />
                </span>
                <div>
                  <p className="sec-meta">AI秘書（音声）</p>
                  <p className="sec-bubble">{turn.text}</p>
                </div>
              </div>
            ),
          )}
          {(running || (live && voice.phase === 'thinking')) && (
            <div className="sec-msg ai pending">
              <span className="sec-ai-icon">
                <AudioLines size={16} />
              </span>
              <div>
                <p className="sec-typing">
                  <Bars count={6} className="sec-mini-wave" />
                  <span className="sec-dots">
                    <i />
                    <i />
                    <i />
                  </span>
                </p>
              </div>
            </div>
          )}
          <div ref={bottom} />
        </div>
        {(error || voice.error) && (
          <p className="sec-error" role="alert">
            {error || voice.error}
          </p>
        )}
        <form
          className="sec-input"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <input
            ref={input}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="メッセージを入力..."
            aria-label="メッセージ"
            disabled={!loaded}
          />
          <button
            type="button"
            className="sec-input-voice"
            aria-label="声で話す"
            disabled={onCall || !setup.voice || !loaded}
            onClick={() => void voice.start()}
          >
            <AudioLines size={20} />
          </button>
          <button
            className="sec-send"
            aria-label="送信"
            disabled={!draft.trim() || running || !loaded}
          >
            <SendHorizontal size={18} />
          </button>
        </form>
      </aside>
    </div>
  );
}
