import { useEffect, useRef } from 'react';
import type { AudioLevels, LiveDotPhase } from './LiveDot';

const palette: Record<LiveDotPhase, [string, string]> = {
  idle: ['#3d7bff', '#6a8cff'],
  connecting: ['#3d7bff', '#22d3ee'],
  listening: ['#a855f7', '#ec4899'],
  thinking: ['#f59e0b', '#f472b6'],
  speaking: ['#22d3ee', '#3d7bff'],
};

const rgba = (hex: string, alpha: number) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${alpha.toFixed(3)})`;
};

/** Layered voice waves that follow the speaking side's audio level. */
export function VoiceWave({
  phase,
  getLevels,
}: {
  phase: LiveDotPhase;
  getLevels: () => AudioLevels;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const phaseRef = useRef(phase);
  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);
  useEffect(() => {
    const el = canvas.current;
    const ctx = el?.getContext('2d');
    if (!el || !ctx) return;
    let frame = 0;
    let amp = 0;
    let time = 0;
    const draw = () => {
      frame = requestAnimationFrame(draw);
      const dpr = window.devicePixelRatio || 1;
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (el.width !== Math.round(w * dpr)) el.width = Math.round(w * dpr);
      if (el.height !== Math.round(h * dpr)) el.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const p = phaseRef.current;
      const { input, output } = getLevels();
      const target =
        p === 'speaking'
          ? Math.min(1, output * 2.2)
          : p === 'listening'
            ? Math.min(1, input * 2.2)
            : p === 'thinking'
              ? 0.18
              : p === 'connecting'
                ? 0.12
                : 0.05;
      amp += (target - amp) * 0.12;
      time += p === 'thinking' ? 0.035 : 0.022 + amp * 0.05;
      const [a, b] = palette[p];
      const mid = h * 0.44;

      const radius = Math.min(w, h) * (0.24 + amp * 0.2);
      const glow = ctx.createRadialGradient(w / 2, mid, 0, w / 2, mid, radius);
      glow.addColorStop(0, rgba(a, 0.22 + amp * 0.35));
      glow.addColorStop(1, rgba(a, 0));
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, w, h);

      ctx.globalCompositeOperation = 'lighter';
      ctx.shadowColor = a;
      ctx.shadowBlur = 16;
      for (let k = 0; k < 5; k++) {
        const stroke = ctx.createLinearGradient(0, 0, w, 0);
        stroke.addColorStop(0, rgba(a, 0));
        stroke.addColorStop(0.5, rgba(k % 2 ? b : a, 0.9 - k * 0.12));
        stroke.addColorStop(1, rgba(b, 0));
        ctx.strokeStyle = stroke;
        ctx.lineWidth = k === 0 ? 3 : 1.6;
        ctx.beginPath();
        for (let x = 0; x <= w; x += 4) {
          const u = x / w;
          const envelope = Math.sin(Math.PI * u) ** 2;
          const y =
            mid +
            Math.sin(
              u * (6 + k * 1.7) * Math.PI + time * (1.4 + k * 0.35) + k,
            ) *
              envelope *
              h *
              0.26 *
              (0.06 + amp) *
              (1 - k * 0.14);
          if (x === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
      ctx.globalCompositeOperation = 'source-over';
      ctx.shadowBlur = 0;
    };
    draw();
    return () => cancelAnimationFrame(frame);
  }, [getLevels]);
  return <canvas ref={canvas} className="sec-wave-canvas" aria-hidden />;
}
