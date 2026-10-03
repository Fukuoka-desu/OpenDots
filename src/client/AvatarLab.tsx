import { useEffect, useRef, useState } from 'react';
import { LiveDot, type AudioLevels, type LiveDotPhase } from './LiveDot';

const phases: { id: LiveDotPhase; label: string }[] = [
  { id: 'idle', label: '待機' },
  { id: 'connecting', label: '接続中' },
  { id: 'listening', label: '聞いている' },
  { id: 'thinking', label: '考え中' },
  { id: 'speaking', label: '話している' },
];
const identities = ['blue', 'mint', 'orange', 'purple'];
// Identities whose characterFor hash lands on each palette.
const identityFor: Record<string, string> = {};
for (
  let index = 0;
  Object.keys(identityFor).length < 4 && index < 500;
  index++
) {
  const candidate = `lab-${index}`;
  let hash = 0;
  for (const character of candidate)
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  const color = identities[hash % identities.length];
  identityFor[color] ??= candidate;
}

function rms(analyser: AnalyserNode, buffer: Float32Array<ArrayBuffer>) {
  analyser.getFloatTimeDomainData(buffer);
  let sum = 0;
  for (const sample of buffer) sum += sample * sample;
  return Math.sqrt(sum / buffer.length);
}

/** Dev-only playground (`/?avatar-lab`) for tuning the call avatar without voice credentials. */
export function AvatarLab() {
  const [phase, setPhase] = useState<LiveDotPhase>('idle');
  const [color, setColor] = useState('blue');
  const [mic, setMic] = useState<'off' | 'input' | 'lipsync'>('off');
  const [demo, setDemo] = useState(false);
  const [error, setError] = useState('');
  const levels = useRef<AudioLevels>({ input: 0, output: 0 });
  const analyser = useRef<{
    node: AnalyserNode;
    buffer: Float32Array<ArrayBuffer>;
    stop: () => void;
  } | null>(null);
  const demoStart = useRef(0);

  useEffect(() => {
    if (mic === 'off') return;
    let cancelled = false;
    void navigator.mediaDevices
      .getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      })
      .then((stream) => {
        if (cancelled) return stream.getTracks().forEach((t) => t.stop());
        const context = new AudioContext();
        const node = context.createAnalyser();
        node.fftSize = 1024;
        context.createMediaStreamSource(stream).connect(node);
        analyser.current = {
          node,
          buffer: new Float32Array(node.fftSize),
          stop: () => {
            stream.getTracks().forEach((t) => t.stop());
            void context.close();
          },
        };
      })
      .catch((e: Error) => {
        setError(`マイクを使えません: ${e.message}`);
        setMic('off');
      });
    return () => {
      cancelled = true;
      analyser.current?.stop();
      analyser.current = null;
    };
  }, [mic]);

  const speakDemo = () => {
    setPhase('speaking');
    setDemo(true);
    demoStart.current = performance.now();
    if ('speechSynthesis' in window) {
      const utterance = new SpeechSynthesisUtterance(
        'こんにちは！わたしはあなたのドットです。話しかけてくれたら、すぐにお返事しますね。',
      );
      utterance.lang = 'ja-JP';
      utterance.onend = () => setDemo(false);
      speechSynthesis.cancel();
      speechSynthesis.speak(utterance);
    }
    setTimeout(() => setDemo(false), 6500);
  };

  const getLevels = () => {
    const current = analyser.current;
    const micLevel = current ? rms(current.node, current.buffer) : 0;
    let output = 0;
    if (demo) {
      // Syllable-like envelope (~6 Hz) with phrase pauses, as a stand-in for TTS audio.
      const t = (performance.now() - demoStart.current) / 1000;
      const syllable = Math.max(0, Math.sin(t * Math.PI * 6.2)) ** 1.5;
      const phrase = Math.sin(t * 1.3) > -0.55 ? 1 : 0;
      output = 0.18 * syllable * phrase * (0.7 + 0.3 * Math.sin(t * 17));
    }
    if (mic === 'lipsync') output = Math.max(output, micLevel);
    levels.current = { input: mic === 'input' ? micLevel : 0, output };
    return levels.current;
  };

  return (
    <main className="avatar-lab">
      <h1>Dot アバター ラボ</h1>
      <p className="avatar-lab-note">
        通話中のアバターの動きを、APIキーなしで確認できます。本番の通話では、Gemini
        Live / ElevenLabs の音声の大きさで同じように動きます。
      </p>
      <div className="avatar-lab-stage">
        <LiveDot
          phase={phase}
          identity={identityFor[color]}
          name="Dot"
          getLevels={getLevels}
          size={280}
        />
        <p role="status">{phases.find((p) => p.id === phase)?.label}</p>
      </div>
      <div className="avatar-lab-row" role="group" aria-label="状態">
        {phases.map((item) => (
          <button
            key={item.id}
            aria-pressed={phase === item.id}
            onClick={() => setPhase(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div className="avatar-lab-row" role="group" aria-label="色">
        {identities.map((item) => (
          <button
            key={item}
            className={`avatar-lab-swatch ${item}`}
            aria-pressed={color === item}
            aria-label={item}
            onClick={() => setColor(item)}
          />
        ))}
      </div>
      <div className="avatar-lab-row">
        <button onClick={speakDemo}>デモ発話（口パク）</button>
        <button
          aria-pressed={mic === 'input'}
          onClick={() => {
            setPhase('listening');
            setMic(mic === 'input' ? 'off' : 'input');
          }}
        >
          マイク → 聞いている反応
        </button>
        <button
          aria-pressed={mic === 'lipsync'}
          onClick={() => {
            setPhase('speaking');
            setMic(mic === 'lipsync' ? 'off' : 'lipsync');
          }}
        >
          マイク → 口パク
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
    </main>
  );
}
