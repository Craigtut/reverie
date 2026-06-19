// The CRT / convex-glass post-process, shared by the terminal renderer and the
// retro loading sequences.
//
// This is a 2D screen-space lens warp in a fragment shader, NOT a 3D transform:
// the "looking through curved glass" feel is a radial UV remap (the same
// Brown-Conrady-style barrel distortion a real CRT shader uses), plus optional
// chromatic aberration, vignette, scanlines, an RGB subpixel mask, bloom, film
// grain and flicker. Everything composites in a single full-screen pass over a
// content texture; bloom adds a small separable-blur pre-pass.
//
// Two presets ride the SAME pipeline:
//   - glass: the always-on readable terminal. Constant gentle barrel + faint
//     vignette + a whisper of chromatic aberration. NO bloom (it blows out
//     text), no mask, no time-driven grain/flicker, so it can run inside the
//     terminal's existing dirty-row paint with no animation loop.
//   - boot: the loading sequences only. Same barrel bulge, but bloom, scanlines,
//     the RGB mask, grain and flicker are cranked. These run in shell-level
//     canvases that own a rAF loop, so the time-driven layers are allowed there.
//
// The barrel curvature is intentionally a single shared constant (CRT_CURVATURE)
// so the glass bulge stays identical everywhere; only the cosmetic layers differ
// between presets. `crtCurve` below is mirrored exactly in CRT_CURVE_GLSL and in
// the pointer hit-test (see terminal/interaction): keep all three in lockstep.

export const CRT_CURVATURE = 0.025;

export interface CrtParams {
  // Barrel strength. Shared across presets so the bulge is constant.
  curvature: number;
  // Chromatic aberration, in UV units, scaled by radial distance (0 at center).
  aberration: number;
  // Edge darkening, 0..1.
  vignette: number;
  // Scanline darkness, 0..1.
  scanline: number;
  // Device px per scanline pair.
  scanlineScale: number;
  // RGB subpixel mask strength, 0..1 (boot only; moires on small text).
  mask: number;
  // Device px width of one R/G/B subpixel column.
  maskScale: number;
  // Bloom add strength (0 disables the bloom pre-pass entirely).
  bloom: number;
  // Luminance threshold for what blooms.
  bloomThreshold: number;
  // Film grain amount, 0..1 (time-driven).
  grain: number;
  // Brightness flicker amount, 0..1 (time-driven).
  flicker: number;
}

// The always-on terminal glass. Tuned (2026-06-17, in the CRT tuning harness) to
// stay readable: gentle curvature + vignette, barely-perceptible aberration, a
// hair of scanline, and a very subtle bloom. The heavier CRT layers stay off.
export const CRT_GLASS_PRESET: CrtParams = {
  curvature: 0.025,
  aberration: 0.0009,
  vignette: 0.16,
  scanline: 0.07,
  scanlineScale: 3,
  mask: 0,
  maskScale: 3,
  bloom: 0.35,
  bloomThreshold: 0.6,
  grain: 0,
  flicker: 0,
};

// The loading-sequence look: same bulge, everything else cranked. Used only by
// the boot / resume canvases, never over live terminal text. Tuned in the
// harness against the Reverie boot screen.
export const CRT_BOOT_PRESET: CrtParams = {
  curvature: 0.025,
  aberration: 0.003,
  vignette: 0.34,
  scanline: 0.24,
  scanlineScale: 3,
  mask: 0.02,
  maskScale: 1.5,
  bloom: 1.75,
  bloomThreshold: 0.06,
  grain: 0.2,
  flicker: 0.2,
};

export function crtParams(overrides: Partial<CrtParams> = {}, base = CRT_GLASS_PRESET): CrtParams {
  return { ...base, ...overrides };
}

// Forward barrel warp, top-left-origin UV in [0,1]. The displayed pixel at
// screen point `s` samples content at `crtCurve(s)`, so this same function maps
// a pointer position to the content cell under it (no inverse needed). MUST stay
// identical to CRT_CURVE_GLSL below and to the hit-test copy.
//
// True RADIAL Brown-Conrady barrel (the shader.se shape): every point is pushed
// out by its distance from center, factor = 1 + k·r² with r² = x² + y². So the
// edge midpoints curve (unlike the older "bend each axis by the square of the
// other axis" form, which left the on-axis midpoints flat and made only the
// corners bulge), giving the convex pane the perceived shape of a sphere section.
export function crtCurve(u: number, v: number, curvature: number): { u: number; v: number } {
  const cx = u * 2 - 1;
  const cy = v * 2 - 1;
  const factor = 1 + curvature * (cx * cx + cy * cy);
  return { u: cx * factor * 0.5 + 0.5, v: cy * factor * 0.5 + 0.5 };
}

// GLSL mirror of `crtCurve`. Radial barrel: push each point out by 1 + k·r²,
// so the whole surface bows like a sphere section, not just the corners.
const CRT_CURVE_GLSL = `
vec2 crtCurve(vec2 uv, float k) {
  vec2 c = uv * 2.0 - 1.0;
  c *= 1.0 + k * dot(c, c);
  return c * 0.5 + 0.5;
}
`;

// Full-screen triangle. v_uv is a standard bottom-left-origin texcoord so every
// intermediate pass (grain, bloom) is a faithful 1:1 copy with no orientation
// flips between passes. The single Y reconciliation (the terminal content FBO is
// stored with its top row at v=1) and the conversion to top-left pointer/cell
// space both happen in the final pass.
const FULLSCREEN_VERTEX_SHADER = `#version 300 es
in vec2 a_position;
out vec2 v_uv;
void main() {
  v_uv = a_position * 0.5 + 0.5;
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

const FINAL_FRAGMENT_SHADER = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 out_color;

uniform sampler2D u_content;
uniform sampler2D u_bloomTex;
uniform vec2 u_resolution;     // drawing-buffer size in device px
uniform float u_time;          // seconds, for grain/flicker
uniform float u_curvature;
uniform float u_aberration;
uniform float u_vignette;
uniform float u_scanline;
uniform float u_scanlineScale;
uniform float u_mask;
uniform float u_maskScale;
uniform float u_bloom;
uniform vec4 u_background;      // premultiplied bezel/background fill
uniform float u_alphaMode;     // 1.0 when the canvas is alpha-backed

${CRT_CURVE_GLSL}

// Sample content with a top-left-origin coordinate, flipping Y for the texture.
vec4 sampleContent(vec2 uvTL) {
  return texture(u_content, vec2(uvTL.x, 1.0 - uvTL.y));
}

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}

void main() {
  // v_uv is bottom-left origin; convert to a top-left coordinate so the warp
  // matches the pointer hit-test space, then sample content (stored top-row at
  // v=1) with a Y flip via sampleContent.
  vec2 ptl = vec2(v_uv.x, 1.0 - v_uv.y);
  vec2 uv = crtCurve(ptl, u_curvature);

  // Outside the warped frame is the rounded bezel: background fill (or
  // transparent so the shell shows through in alpha mode).
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    out_color = u_alphaMode > 0.5 ? vec4(0.0) : u_background;
    return;
  }

  // Radial term: 0 at center, ~1 at corners. Drives aberration + vignette.
  vec2 fromCenter = uv - 0.5;
  float r2 = dot(fromCenter, fromCenter) * 4.0;

  vec4 base;
  if (u_aberration > 0.0) {
    vec2 dir = fromCenter * (u_aberration * r2);
    base.r = sampleContent(uv + dir).r;
    vec4 g = sampleContent(uv);
    base.g = g.g;
    base.a = g.a;
    base.b = sampleContent(uv - dir).b;
  } else {
    base = sampleContent(uv);
  }
  vec3 color = base.rgb;
  float alpha = base.a;

  if (u_bloom > 0.0) {
    vec3 bloom = texture(u_bloomTex, vec2(uv.x, 1.0 - uv.y)).rgb;
    color += bloom * u_bloom;
    alpha = max(alpha, clamp(max(bloom.r, max(bloom.g, bloom.b)) * u_bloom, 0.0, 1.0));
  }

  // The phosphor structure (mask + scanlines) lives on the curved glass, so it
  // is keyed off the WARPED coordinate (uv) rather than the flat screen coord:
  // the columns/lines bend with the barrel and compress toward the edges, the
  // way a real CRT's mask and scanlines do, instead of staying ruler-straight.

  // RGB subpixel mask: light one channel per device-px column, soft-blended.
  if (u_mask > 0.0) {
    float col = floor((uv.x * u_resolution.x) / u_maskScale);
    float idx = mod(col, 3.0);
    vec3 m = vec3(idx == 0.0, idx == 1.0, idx == 2.0) * 3.0;
    vec3 masked = color * m;
    color = mix(color, masked, u_mask);
  }

  // Scanlines: darken between beam lines along the warped vertical axis.
  if (u_scanline > 0.0) {
    float line = sin((uv.y * u_resolution.y) * 3.14159265 / u_scanlineScale);
    float s = 1.0 - u_scanline * (0.5 - 0.5 * line);
    color *= s;
  }

  // Vignette from the radial term.
  if (u_vignette > 0.0) {
    color *= 1.0 - u_vignette * smoothstep(0.4, 1.4, r2);
  }

  // Grain + flicker run in a pre-pass (see GRAIN_FLICKER_FRAGMENT_SHADER) so
  // this warp pass stays branch-light for the always-on glass path.

  out_color = vec4(color, u_alphaMode > 0.5 ? alpha : 1.0);
}
`;

const GRAIN_FLICKER_FRAGMENT_SHADER = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 out_color;
uniform sampler2D u_content;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_grain;
uniform float u_flicker;
float hash(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}
void main() {
  vec4 c = texture(u_content, v_uv);
  vec3 color = c.rgb;
  if (u_flicker > 0.0) {
    float f = 1.0 - u_flicker * hash(vec2(u_time, 0.0));
    color *= f;
  }
  if (u_grain > 0.0) {
    float n = hash(v_uv * u_resolution + fract(u_time) * 100.0) - 0.5;
    // Scale by coverage so grain rides only painted pixels: on a transparent
    // (premultiplied) canvas, c.a is 0 where nothing is drawn, so no grain
    // leaks into the empty area (which would reveal the canvas rectangle).
    color += n * u_grain * c.a;
  }
  out_color = vec4(color, c.a);
}
`;

const BRIGHT_FRAGMENT_SHADER = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 out_color;
uniform sampler2D u_content;
uniform float u_threshold;
void main() {
  vec3 c = texture(u_content, v_uv).rgb;
  float l = dot(c, vec3(0.299, 0.587, 0.114));
  float k = max(0.0, l - u_threshold) / max(0.0001, 1.0 - u_threshold);
  out_color = vec4(c * k, 1.0);
}
`;

const BLUR_FRAGMENT_SHADER = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 out_color;
uniform sampler2D u_content;
uniform vec2 u_direction; // texel step along blur axis
void main() {
  vec3 sum = texture(u_content, v_uv).rgb * 0.227027;
  sum += texture(u_content, v_uv + u_direction * 1.3846).rgb * 0.316216;
  sum += texture(u_content, v_uv - u_direction * 1.3846).rgb * 0.316216;
  sum += texture(u_content, v_uv + u_direction * 3.2308).rgb * 0.070270;
  sum += texture(u_content, v_uv - u_direction * 3.2308).rgb * 0.070270;
  out_color = vec4(sum, 1.0);
}
`;

interface RenderTarget {
  framebuffer: WebGLFramebuffer;
  texture: WebGLTexture;
  width: number;
  height: number;
}

export interface CrtPass {
  // The framebuffer the source content should be drawn into. Re-fetch after a
  // resize. Null-safe: returns the content FBO, never the screen.
  contentFramebuffer(): WebGLFramebuffer;
  contentTexture(): WebGLTexture;
  // Load 2D content (a canvas/image) into the content texture instead of
  // rendering into the FBO. Used by the loading sequences, which draw their
  // symbol/bar/constellation on a 2D canvas and pipe it through the CRT pass.
  // The source should match the pass size; it is uploaded top-row-up to match
  // the terminal renderer's orientation.
  uploadContent(source: TexImageSource): void;
  resize(width: number, height: number): void;
  width(): number;
  height(): number;
  // Composite the content FBO to the default framebuffer with the given params.
  // `timeSeconds < 0` disables grain/flicker (the static glass path).
  render(params: CrtParams, timeSeconds: number, background: PremultipliedColor): void;
  dispose(): void;
}

export interface PremultipliedColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

export function createCrtPass(gl: WebGL2RenderingContext, width: number, height: number): CrtPass {
  const quad = gl.createBuffer();
  if (!quad) throw new Error('CRT quad buffer allocation failed');
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.bindBuffer(gl.ARRAY_BUFFER, null);

  const finalProgram = buildProgram(gl, FINAL_FRAGMENT_SHADER);
  const grainProgram = buildProgram(gl, GRAIN_FLICKER_FRAGMENT_SHADER);
  const brightProgram = buildProgram(gl, BRIGHT_FRAGMENT_SHADER);
  const blurProgram = buildProgram(gl, BLUR_FRAGMENT_SHADER);

  let content = createTarget(gl, width, height, gl.LINEAR);
  // Bloom + grain scratch targets are lazily sized to half res on first use.
  let bloomA: RenderTarget | null = null;
  let bloomB: RenderTarget | null = null;
  let scratch: RenderTarget | null = null;

  function ensureBloomTargets() {
    const bw = Math.max(1, Math.floor(content.width / 2));
    const bh = Math.max(1, Math.floor(content.height / 2));
    if (bloomA && (bloomA.width !== bw || bloomA.height !== bh)) {
      destroyTarget(gl, bloomA);
      bloomA = null;
    }
    if (bloomB && (bloomB.width !== bw || bloomB.height !== bh)) {
      destroyTarget(gl, bloomB);
      bloomB = null;
    }
    if (!bloomA) bloomA = createTarget(gl, bw, bh, gl.LINEAR);
    if (!bloomB) bloomB = createTarget(gl, bw, bh, gl.LINEAR);
  }

  function ensureScratch() {
    if (scratch && (scratch.width !== content.width || scratch.height !== content.height)) {
      destroyTarget(gl, scratch);
      scratch = null;
    }
    if (!scratch) scratch = createTarget(gl, content.width, content.height, gl.LINEAR);
    return scratch;
  }

  function drawFullscreen(program: WebGLProgram) {
    const loc = gl.getAttribLocation(program, 'a_position');
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  }

  function buildBloom(params: CrtParams): WebGLTexture {
    ensureBloomTargets();
    const a = bloomA as RenderTarget;
    const b = bloomB as RenderTarget;
    gl.disable(gl.BLEND);

    // Bright extract: content -> bloomA (half res).
    gl.bindFramebuffer(gl.FRAMEBUFFER, a.framebuffer);
    gl.viewport(0, 0, a.width, a.height);
    // biome-ignore lint/correctness/useHookAtTopLevel: WebGL useProgram is not a React hook.
    gl.useProgram(brightProgram);
    bindTexture(gl, brightProgram, 'u_content', content.texture, 0);
    gl.uniform1f(gl.getUniformLocation(brightProgram, 'u_threshold'), params.bloomThreshold);
    drawFullscreen(brightProgram);

    // Separable blur: A -> B (horizontal) -> A (vertical).
    // biome-ignore lint/correctness/useHookAtTopLevel: WebGL useProgram is not a React hook.
    gl.useProgram(blurProgram);
    gl.bindFramebuffer(gl.FRAMEBUFFER, b.framebuffer);
    gl.viewport(0, 0, b.width, b.height);
    bindTexture(gl, blurProgram, 'u_content', a.texture, 0);
    gl.uniform2f(gl.getUniformLocation(blurProgram, 'u_direction'), 1 / a.width, 0);
    drawFullscreen(blurProgram);

    gl.bindFramebuffer(gl.FRAMEBUFFER, a.framebuffer);
    gl.viewport(0, 0, a.width, a.height);
    bindTexture(gl, blurProgram, 'u_content', b.texture, 0);
    gl.uniform2f(gl.getUniformLocation(blurProgram, 'u_direction'), 0, 1 / b.height);
    drawFullscreen(blurProgram);

    return a.texture;
  }

  return {
    contentFramebuffer: () => content.framebuffer,
    contentTexture: () => content.texture,
    uploadContent(source: TexImageSource) {
      gl.bindTexture(gl.TEXTURE_2D, content.texture);
      // Flip Y so the 2D canvas's top row lands at texture v=1 (matching the
      // terminal FBO orientation), and premultiply so the texture matches the
      // premultiplied convention the rest of the pass assumes (a faint 2D pixel
      // becomes a faint color, so bloom and compositing are coverage-weighted).
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.bindTexture(gl.TEXTURE_2D, null);
    },
    width: () => content.width,
    height: () => content.height,
    resize(w: number, h: number) {
      if (w === content.width && h === content.height) return;
      destroyTarget(gl, content);
      content = createTarget(gl, w, h, gl.LINEAR);
    },
    render(params: CrtParams, timeSeconds: number, background: PremultipliedColor) {
      let source = content.texture;

      // Time-driven grain/flicker is a separate pre-pass so the warp pass stays
      // branch-light. Only runs when something is animated.
      if (timeSeconds >= 0 && (params.grain > 0 || params.flicker > 0)) {
        const target = ensureScratch();
        gl.disable(gl.BLEND);
        gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
        gl.viewport(0, 0, target.width, target.height);
        // biome-ignore lint/correctness/useHookAtTopLevel: WebGL useProgram is not a React hook.
        gl.useProgram(grainProgram);
        bindTexture(gl, grainProgram, 'u_content', content.texture, 0);
        gl.uniform2f(
          gl.getUniformLocation(grainProgram, 'u_resolution'),
          content.width,
          content.height,
        );
        gl.uniform1f(gl.getUniformLocation(grainProgram, 'u_time'), timeSeconds);
        gl.uniform1f(gl.getUniformLocation(grainProgram, 'u_grain'), params.grain);
        gl.uniform1f(gl.getUniformLocation(grainProgram, 'u_flicker'), params.flicker);
        drawFullscreen(grainProgram);
        source = target.texture;
      }

      let bloomTexture: WebGLTexture | null = null;
      if (params.bloom > 0) {
        bloomTexture = buildBloom(params);
      }

      // Final composite to the screen.
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, content.width, content.height);
      gl.disable(gl.BLEND);
      // biome-ignore lint/correctness/useHookAtTopLevel: WebGL useProgram is not a React hook.
      gl.useProgram(finalProgram);
      bindTexture(gl, finalProgram, 'u_content', source, 0);
      bindTexture(gl, finalProgram, 'u_bloomTex', bloomTexture ?? source, 1);
      gl.uniform2f(
        gl.getUniformLocation(finalProgram, 'u_resolution'),
        content.width,
        content.height,
      );
      gl.uniform1f(gl.getUniformLocation(finalProgram, 'u_time'), timeSeconds);
      gl.uniform1f(gl.getUniformLocation(finalProgram, 'u_curvature'), params.curvature);
      gl.uniform1f(gl.getUniformLocation(finalProgram, 'u_aberration'), params.aberration);
      gl.uniform1f(gl.getUniformLocation(finalProgram, 'u_vignette'), params.vignette);
      gl.uniform1f(gl.getUniformLocation(finalProgram, 'u_scanline'), params.scanline);
      gl.uniform1f(
        gl.getUniformLocation(finalProgram, 'u_scanlineScale'),
        Math.max(1, params.scanlineScale),
      );
      gl.uniform1f(gl.getUniformLocation(finalProgram, 'u_mask'), params.mask);
      gl.uniform1f(
        gl.getUniformLocation(finalProgram, 'u_maskScale'),
        Math.max(1, params.maskScale),
      );
      gl.uniform1f(gl.getUniformLocation(finalProgram, 'u_bloom'), bloomTexture ? params.bloom : 0);
      gl.uniform4f(
        gl.getUniformLocation(finalProgram, 'u_background'),
        background.r,
        background.g,
        background.b,
        background.a,
      );
      gl.uniform1f(gl.getUniformLocation(finalProgram, 'u_alphaMode'), background.a < 1 ? 1 : 0);
      drawFullscreen(finalProgram);

      gl.enable(gl.BLEND);
    },
    dispose() {
      destroyTarget(gl, content);
      if (bloomA) destroyTarget(gl, bloomA);
      if (bloomB) destroyTarget(gl, bloomB);
      if (scratch) destroyTarget(gl, scratch);
      gl.deleteBuffer(quad);
      gl.deleteProgram(finalProgram);
      gl.deleteProgram(grainProgram);
      gl.deleteProgram(brightProgram);
      gl.deleteProgram(blurProgram);
    },
  };
}

function createTarget(
  gl: WebGL2RenderingContext,
  width: number,
  height: number,
  filter: number,
): RenderTarget {
  const texture = gl.createTexture();
  if (!texture) throw new Error('CRT target texture allocation failed');
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const framebuffer = gl.createFramebuffer();
  if (!framebuffer) throw new Error('CRT framebuffer allocation failed');
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return { framebuffer, texture, width, height };
}

function destroyTarget(gl: WebGL2RenderingContext, target: RenderTarget) {
  gl.deleteFramebuffer(target.framebuffer);
  gl.deleteTexture(target.texture);
}

function bindTexture(
  gl: WebGL2RenderingContext,
  program: WebGLProgram,
  name: string,
  texture: WebGLTexture,
  unit: number,
) {
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.uniform1i(gl.getUniformLocation(program, name), unit);
}

function buildProgram(gl: WebGL2RenderingContext, fragmentSource: string): WebGLProgram {
  const vertex = compile(gl, gl.VERTEX_SHADER, FULLSCREEN_VERTEX_SHADER);
  const fragment = compile(gl, gl.FRAGMENT_SHADER, fragmentSource);
  const program = gl.createProgram();
  if (!program) throw new Error('CRT program allocation failed');
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(program) || 'CRT program link failed');
  }
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  return program;
}

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('CRT shader allocation failed');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(shader) || 'CRT shader compile failed');
  }
  return shader;
}
