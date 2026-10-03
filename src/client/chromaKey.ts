const vertex = `attribute vec2 p;
varying vec2 uv;
void main() {
  uv = vec2(p.x + 1.0, 1.0 - p.y) * 0.5;
  gl_Position = vec4(p, 0.0, 1.0);
}`;

// Keys out the avatar's green screen and suppresses green spill on edges.
const fragment = `precision mediump float;
varying vec2 uv;
uniform sampler2D frame;
void main() {
  vec4 c = texture2D(frame, uv);
  float rb = max(c.r, c.b);
  float alpha = 1.0 - smoothstep(0.06, 0.2, c.g - rb);
  c.g = min(c.g, rb + 0.03);
  gl_FragColor = vec4(c.rgb * alpha, alpha);
}`;

export function startChromaKey(
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
): (() => void) | undefined {
  const gl = canvas.getContext('webgl', { premultipliedAlpha: true });
  if (!gl) return undefined;

  const shader = (type: number, source: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, source);
    gl.compileShader(s);
    return s;
  };
  const program = gl.createProgram()!;
  gl.attachShader(program, shader(gl.VERTEX_SHADER, vertex));
  gl.attachShader(program, shader(gl.FRAGMENT_SHADER, fragment));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return undefined;
  gl.useProgram(program);

  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
    gl.STATIC_DRAW,
  );
  const position = gl.getAttribLocation(program, 'p');
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

  gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

  let frame = 0;
  const draw = () => {
    frame = requestAnimationFrame(draw);
    if (video.readyState < 2 || !video.videoWidth) return;
    if (canvas.width !== video.videoWidth) canvas.width = video.videoWidth;
    if (canvas.height !== video.videoHeight) canvas.height = video.videoHeight;
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  };
  draw();
  return () => cancelAnimationFrame(frame);
}
