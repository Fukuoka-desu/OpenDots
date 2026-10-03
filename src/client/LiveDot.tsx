import { useEffect, useRef } from 'react';
import { characterFor } from './Mascot';

export type LiveDotPhase =
  'idle' | 'connecting' | 'listening' | 'thinking' | 'speaking';

export type AudioLevels = { input: number; output: number };

const palettes = {
  blue: { light: '#9cc0ff', base: '#3f7dff', dark: '#1c46c4', aura: '#6f9dff' },
  mint: { light: '#a8f2db', base: '#2fc49b', dark: '#138367', aura: '#5fe0bb' },
  orange: {
    light: '#ffd0a8',
    base: '#ff8b3d',
    dark: '#d8561a',
    aura: '#ffab6e',
  },
  purple: {
    light: '#d6c3ff',
    base: '#9468ff',
    dark: '#5f34d6',
    aura: '#b393ff',
  },
} as const;

const silent = (): AudioLevels => ({ input: 0, output: 0 });

/** Speech RMS rarely exceeds ~0.3; expand it into a 0..1 animation drive. */
const drive = (rms: number) => Math.min(1, Math.sqrt(Math.max(0, rms)) * 1.6);

function approach(
  current: number,
  target: number,
  attack: number,
  release: number,
) {
  return current + (target - current) * (target > current ? attack : release);
}

/**
 * Audio-reactive Dot body: a soft blob whose mouth, squash and aura follow
 * live call levels. Levels are read every frame, so no React state is involved.
 */
export function LiveDot({
  phase,
  identity,
  name = 'Dot',
  getLevels = silent,
  size = 180,
}: {
  phase: LiveDotPhase;
  identity?: string;
  name?: string;
  getLevels?: () => AudioLevels;
  size?: number;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const live = useRef({ phase, getLevels });
  live.current = { phase, getLevels };
  const palette = palettes[characterFor(identity)];

  useEffect(() => {
    const element = canvas.current;
    const context = element?.getContext('2d');
    if (!element || !context) return;
    const reduced = window.matchMedia?.(
      '(prefers-reduced-motion: reduce)',
    ).matches;
    const motion = reduced ? 0.25 : 1;
    const anim = {
      input: 0,
      output: 0,
      mouth: 0,
      blink: 0,
      nextBlink: 1.5,
      gazeX: 0,
      gazeY: 0,
      thinking: 0,
      listening: 0,
      ripple: [] as { born: number; strength: number }[],
      lastRipple: 0,
    };
    let frame = 0;
    let last = performance.now();
    let time = 0;

    const draw = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      time += dt;
      const ratio = window.devicePixelRatio || 1;
      const pixels = Math.round(size * ratio);
      if (element.width !== pixels) {
        element.width = pixels;
        element.height = pixels;
      }
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, size, size);

      const { phase: current, getLevels: read } = live.current;
      const levels = read();
      const speaking = current === 'speaking';
      const listening = current === 'listening';
      anim.output = approach(
        anim.output,
        speaking ? drive(levels.output) : 0,
        0.55,
        0.18,
      );
      anim.input = approach(
        anim.input,
        listening ? drive(levels.input) : 0,
        0.4,
        0.08,
      );
      anim.mouth = approach(anim.mouth, anim.output, 0.6, 0.25);
      anim.thinking = approach(
        anim.thinking,
        current === 'thinking' ? 1 : 0,
        0.08,
        0.08,
      );
      anim.listening = approach(anim.listening, listening ? 1 : 0, 0.08, 0.08);

      if (time > anim.nextBlink) {
        anim.blink = 1;
        anim.nextBlink = time + 2.2 + Math.random() * 3.2;
      }
      anim.blink = Math.max(0, anim.blink - dt * 7);

      const gazeTarget =
        current === 'thinking'
          ? { x: 0.55, y: -0.7 }
          : listening
            ? { x: Math.sin(time * 0.7) * 0.15, y: 0.25 + anim.input * 0.2 }
            : {
                x: Math.sin(time * 0.45) * 0.4,
                y: Math.sin(time * 0.31) * 0.2,
              };
      anim.gazeX = approach(anim.gazeX, gazeTarget.x, 0.06, 0.06);
      anim.gazeY = approach(anim.gazeY, gazeTarget.y, 0.06, 0.06);

      const cx = size / 2;
      const radius = size * 0.31;
      const breath = Math.sin(time * 2.1) * motion;
      const hop = speaking ? anim.output * radius * 0.1 : 0;
      const cy =
        size * 0.5 -
        Math.sin(time * 1.6) * radius * 0.035 * motion -
        hop +
        anim.input * radius * 0.04;
      const squashX =
        1 + 0.07 * anim.output - 0.015 * breath + 0.03 * anim.input;
      const squashY =
        1 - 0.05 * anim.output + 0.015 * breath - 0.02 * anim.input;
      const connecting = current === 'connecting';
      context.globalAlpha = connecting ? 0.55 + 0.25 * Math.sin(time * 4) : 1;

      // Floor shadow.
      context.save();
      context.fillStyle = 'rgba(10, 20, 40, 0.18)';
      context.beginPath();
      context.ellipse(
        cx,
        size * 0.5 + radius * 1.12,
        radius * (0.72 - hop / radius) * squashX,
        radius * 0.1,
        0,
        0,
        Math.PI * 2,
      );
      context.fill();
      context.restore();

      // Listening ripples follow the user's voice.
      if (listening && anim.input > 0.18 && time - anim.lastRipple > 0.35) {
        anim.ripple.push({ born: time, strength: anim.input });
        anim.lastRipple = time;
      }
      anim.ripple = anim.ripple.filter((ripple) => time - ripple.born < 1.4);
      for (const ripple of anim.ripple) {
        const age = (time - ripple.born) / 1.4;
        context.strokeStyle = palette.aura;
        context.globalAlpha = (1 - age) * 0.5 * ripple.strength;
        context.lineWidth = 2.5;
        context.beginPath();
        context.arc(cx, cy, radius * (1.08 + age * 0.45), 0, Math.PI * 2);
        context.stroke();
      }
      context.globalAlpha = connecting ? 0.55 + 0.25 * Math.sin(time * 4) : 1;

      // Soft aura while speaking.
      if (anim.output > 0.02) {
        const aura = context.createRadialGradient(
          cx,
          cy,
          radius * 0.8,
          cx,
          cy,
          radius * 1.45,
        );
        aura.addColorStop(0, `${palette.aura}66`);
        aura.addColorStop(1, `${palette.aura}00`);
        context.fillStyle = aura;
        context.globalAlpha = Math.min(1, anim.output * 1.3);
        context.beginPath();
        context.arc(cx, cy, radius * 1.45, 0, Math.PI * 2);
        context.fill();
        context.globalAlpha = 1;
      }

      // Body outline: layered sines give a jelly-like wobble.
      context.save();
      context.translate(cx, cy);
      context.scale(squashX, squashY);
      context.beginPath();
      const points = 72;
      for (let index = 0; index <= points; index++) {
        const angle = (index / points) * Math.PI * 2;
        const wobble =
          (0.018 * Math.sin(3 * angle + time * 1.3) +
            0.012 * Math.sin(5 * angle - time * 1.9)) *
            motion +
          0.035 * anim.output * Math.sin(4 * angle + time * 9) * motion +
          0.02 * anim.thinking * Math.sin(2 * angle + time * 3);
        const r = radius * (1 + wobble);
        const x = Math.cos(angle) * r;
        const y =
          Math.sin(angle) * r * 0.96 +
          (Math.sin(angle) > 0 ? radius * 0.04 : 0);
        if (index === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
      }
      context.closePath();
      const body = context.createRadialGradient(
        -radius * 0.35,
        -radius * 0.45,
        radius * 0.1,
        0,
        0,
        radius * 1.25,
      );
      body.addColorStop(0, palette.light);
      body.addColorStop(0.45, palette.base);
      body.addColorStop(1, palette.dark);
      context.fillStyle = body;
      context.fill();
      context.clip();
      // Glossy highlight.
      const gloss = context.createRadialGradient(
        -radius * 0.38,
        -radius * 0.55,
        0,
        -radius * 0.38,
        -radius * 0.55,
        radius * 0.55,
      );
      gloss.addColorStop(0, 'rgba(255,255,255,0.55)');
      gloss.addColorStop(1, 'rgba(255,255,255,0)');
      context.fillStyle = gloss;
      context.fillRect(
        -radius * 1.2,
        -radius * 1.2,
        radius * 2.4,
        radius * 2.4,
      );
      context.restore();

      // Face.
      context.save();
      context.translate(cx, cy);
      context.scale(squashX, squashY);
      const eyeY = -radius * 0.1;
      const eyeGap = radius * 0.34;
      const blinkScale = 1 - Math.sin(anim.blink * Math.PI) * 0.92;
      const openness = connecting ? 0.35 : 1 + anim.listening * 0.08;
      for (const side of [-1, 1]) {
        const ex = side * eyeGap + anim.gazeX * radius * 0.05;
        const ey = eyeY + anim.gazeY * radius * 0.05;
        context.fillStyle = '#1b1a2c';
        context.beginPath();
        context.ellipse(
          ex,
          ey,
          radius * 0.12,
          radius * 0.16 * blinkScale * openness,
          0,
          0,
          Math.PI * 2,
        );
        context.fill();
        if (blinkScale > 0.4) {
          context.fillStyle = 'rgba(255,255,255,0.92)';
          context.beginPath();
          context.arc(
            ex - radius * 0.035 + anim.gazeX * radius * 0.03,
            ey - radius * 0.06 * blinkScale + anim.gazeY * radius * 0.02,
            radius * 0.04,
            0,
            Math.PI * 2,
          );
          context.fill();
        }
        context.fillStyle = 'rgba(255, 120, 150, 0.32)';
        context.beginPath();
        context.ellipse(
          side * radius * 0.55,
          radius * 0.17,
          radius * 0.13,
          radius * 0.075,
          0,
          0,
          Math.PI * 2,
        );
        context.fill();
      }
      const mouthY = radius * 0.23;
      if (anim.mouth > 0.06) {
        const width = radius * (0.13 + 0.07 * anim.mouth);
        const height = radius * (0.04 + 0.2 * anim.mouth);
        context.fillStyle = '#2a1426';
        context.beginPath();
        context.ellipse(
          0,
          mouthY + height * 0.3,
          width,
          height,
          0,
          0,
          Math.PI * 2,
        );
        context.fill();
        context.save();
        context.clip();
        context.fillStyle = '#ff7c93';
        context.beginPath();
        context.ellipse(
          0,
          mouthY + height * 1.05,
          width * 0.8,
          height * 0.6,
          0,
          0,
          Math.PI * 2,
        );
        context.fill();
        context.restore();
      } else {
        context.strokeStyle = '#1b1a2c';
        context.lineWidth = Math.max(2, radius * 0.045);
        context.lineCap = 'round';
        context.beginPath();
        const smile = current === 'thinking' ? 0.03 : 0.09;
        context.moveTo(-radius * 0.11, mouthY);
        context.quadraticCurveTo(
          0,
          mouthY + radius * smile,
          radius * 0.11,
          mouthY,
        );
        context.stroke();
      }
      context.restore();

      // Thinking satellites orbit the body.
      if (anim.thinking > 0.02) {
        for (let index = 0; index < 3; index++) {
          const angle = time * 2.4 + (index * Math.PI * 2) / 3;
          const orbit = radius * 1.28;
          const x = cx + Math.cos(angle) * orbit;
          const y = cy + Math.sin(angle) * orbit * 0.38 - radius * 0.15;
          const depth = (Math.sin(angle) + 1) / 2;
          context.globalAlpha = anim.thinking * (0.45 + 0.55 * depth);
          context.fillStyle = index === 1 ? palette.light : palette.aura;
          context.beginPath();
          context.arc(x, y, radius * (0.06 + 0.035 * depth), 0, Math.PI * 2);
          context.fill();
        }
        context.globalAlpha = 1;
      }
      context.globalAlpha = 1;
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [palette, size]);

  return (
    <canvas
      ref={canvas}
      className="live-dot"
      role="img"
      aria-label={`${name} is ${phase}`}
      style={{ width: size, height: size }}
    />
  );
}
