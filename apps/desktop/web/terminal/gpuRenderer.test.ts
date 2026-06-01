import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_TERMINAL_ASYNC_RENDERER_BACKENDS,
  createTerminalGpuRenderer,
  createTerminalGpuRendererAsync,
  terminalRendererBackendPlan,
} from '../terminal-gpu-renderer';
import type { TerminalRendererBackend } from '../terminalTypes';

function fakeCanvas(contexts: Partial<Record<string, unknown>>) {
  const getContext = vi.fn((kind: string) => contexts[kind] ?? null);
  return {
    width: 0,
    height: 0,
    style: {},
    getContext,
  } as unknown as HTMLCanvasElement;
}

function fakeCanvasContext2d(options: { fonts?: string[] } = {}) {
  return {
    scale: vi.fn(),
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    fillText: vi.fn(),
    strokeRect: vi.fn(),
    set textBaseline(_value: string) {},
    set textRendering(_value: string) {},
    set font(value: string) {
      options.fonts?.push(value);
    },
    set fillStyle(_value: string) {},
    set strokeStyle(_value: string) {},
  };
}

function fakeWebGl2Context(options: { lost?: boolean } = {}) {
  const context = {
    ARRAY_BUFFER: 0x8892,
    BLEND: 0x0be2,
    CLAMP_TO_EDGE: 0x812f,
    COLOR_ATTACHMENT0: 0x8ce0,
    COLOR_BUFFER_BIT: 0x4000,
    COMPILE_STATUS: 0x8b81,
    DEPTH_TEST: 0x0b71,
    DRAW_FRAMEBUFFER: 0x8ca9,
    FLOAT: 0x1406,
    FRAMEBUFFER: 0x8d40,
    FRAMEBUFFER_COMPLETE: 0x8cd5,
    FRAGMENT_SHADER: 0x8b30,
    LINEAR: 0x2601,
    LINK_STATUS: 0x8b82,
    NEAREST: 0x2600,
    ONE_MINUS_SRC_ALPHA: 0x0303,
    READ_FRAMEBUFFER: 0x8ca8,
    RGBA: 0x1908,
    SCISSOR_TEST: 0x0c11,
    SRC_ALPHA: 0x0302,
    STREAM_DRAW: 0x88e0,
    TEXTURE0: 0x84c0,
    TEXTURE_2D: 0x0de1,
    TEXTURE_MAG_FILTER: 0x2800,
    TEXTURE_MIN_FILTER: 0x2801,
    TEXTURE_WRAP_S: 0x2802,
    TEXTURE_WRAP_T: 0x2803,
    TRIANGLES: 0x0004,
    UNSIGNED_BYTE: 0x1401,
    VERTEX_SHADER: 0x8b31,
    activeTexture: vi.fn(),
    attachShader: vi.fn(),
    bindBuffer: vi.fn(),
    bindFramebuffer: vi.fn(),
    bindTexture: vi.fn(),
    bindVertexArray: vi.fn(),
    blendFunc: vi.fn(),
    blitFramebuffer: vi.fn(),
    bufferData: vi.fn(),
    checkFramebufferStatus: vi.fn(() => 0x8cd5),
    clear: vi.fn(),
    clearColor: vi.fn(),
    compileShader: vi.fn(),
    createBuffer: vi.fn(() => ({})),
    createFramebuffer: vi.fn(() => ({})),
    createProgram: vi.fn(() => ({})),
    createShader: vi.fn(() => ({})),
    createTexture: vi.fn(() => ({})),
    createVertexArray: vi.fn(() => ({})),
    deleteBuffer: vi.fn(),
    deleteFramebuffer: vi.fn(),
    deleteProgram: vi.fn(),
    deleteTexture: vi.fn(),
    deleteVertexArray: vi.fn(),
    disable: vi.fn(),
    drawArrays: vi.fn(),
    enable: vi.fn(),
    enableVertexAttribArray: vi.fn(),
    getAttribLocation: vi.fn(() => 1),
    getProgramInfoLog: vi.fn(() => ''),
    getProgramParameter: vi.fn(() => true),
    getShaderInfoLog: vi.fn(() => ''),
    getShaderParameter: vi.fn(() => true),
    getUniformLocation: vi.fn(() => ({})),
    framebufferTexture2D: vi.fn(),
    finish: vi.fn(),
    flush: vi.fn(),
    isContextLost: vi.fn(() => options.lost ?? false),
    linkProgram: vi.fn(),
    shaderSource: vi.fn(),
    scissor: vi.fn(),
    texImage2D: vi.fn(),
    texParameteri: vi.fn(),
    texSubImage2D: vi.fn(),
    uniform1i: vi.fn(),
    uniform2f: vi.fn(),
    useProgram: vi.fn(),
    vertexAttribPointer: vi.fn(),
    viewport: vi.fn(),
  };

  return context;
}

describe('terminalRendererBackendPlan', () => {
  it('dedupes requested backends while preserving order', () => {
    expect(
      terminalRendererBackendPlan([
        'webgpu',
        'webgl2',
        'webgl2',
        'canvas2d',
      ] as TerminalRendererBackend[]),
    ).toEqual(['webgpu', 'webgl2', 'canvas2d']);
  });

  it('falls back to the default WebGL2-first plan when empty', () => {
    expect(terminalRendererBackendPlan([])).toEqual(['webgl2', 'canvas2d']);
  });

  it('can omit WebGPU for synchronous renderer planning', () => {
    expect(
      terminalRendererBackendPlan(['webgpu', 'webgl2'], {
        allowWebGpu: false,
      }),
    ).toEqual(['webgl2']);
  });

  it('defines an async WebGPU-first probe plan with WebGL2 fallback', () => {
    expect(DEFAULT_TERMINAL_ASYNC_RENDERER_BACKENDS).toEqual(['webgpu', 'webgl2', 'canvas2d']);
  });
});

describe('createTerminalGpuRenderer', () => {
  beforeEach(() => {
    vi.stubGlobal('window', { devicePixelRatio: 1 });
    vi.stubGlobal('document', {
      createElement: vi.fn(() => ({
        width: 0,
        height: 0,
        getContext: vi.fn(() => fakeCanvasContext2d()),
      })),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('falls back to Canvas when WebGPU and WebGL2 are unavailable', () => {
    const canvas = fakeCanvas({ '2d': fakeCanvasContext2d() });

    const renderer = createTerminalGpuRenderer(canvas, {
      cols: 2,
      rows: 1,
      preferredBackends: ['webgpu', 'webgl2', 'canvas2d'],
    });

    expect(renderer.capabilities.backend).toBe('canvas2d');
    expect(renderer.capabilities).toEqual({
      backend: 'canvas2d',
      gpuAccelerated: false,
      fallback: true,
      explicitResourceManagement: false,
      retainedPartialPaint: true,
    });
    renderer.paintFrame({ dirty: 'full', rows: [{ index: 0, dirty: true, cells: [] }] });
  });

  it('uses WebGL2 first when available and sizes the backing canvas for DPR', () => {
    vi.stubGlobal('window', { devicePixelRatio: 2 });
    const gl = fakeWebGl2Context();
    const canvas = fakeCanvas({ webgl2: gl, '2d': fakeCanvasContext2d() });

    const renderer = createTerminalGpuRenderer(canvas, {
      cols: 4,
      rows: 2,
      cellWidth: 8,
      cellHeight: 10,
    });

    expect(renderer.capabilities.backend).toBe('webgl2');
    expect(renderer.capabilities).toEqual({
      backend: 'webgl2',
      gpuAccelerated: true,
      fallback: false,
      explicitResourceManagement: true,
      retainedPartialPaint: false,
    });
    expect(canvas.width).toBe(64);
    expect(canvas.height).toBe(40);
    expect(canvas.style.width).toBe('32px');
    expect(canvas.style.height).toBe('20px');
    expect(gl.viewport).toHaveBeenCalledWith(0, 0, 64, 40);
    expect(canvas.getContext).toHaveBeenCalledWith(
      'webgl2',
      expect.objectContaining({ preserveDrawingBuffer: true }),
    );
  });

  it('can probe the default async WebGPU path and fall back to WebGL2', async () => {
    const gl = fakeWebGl2Context();
    const canvas = fakeCanvas({ webgl2: gl, '2d': fakeCanvasContext2d() });

    const renderer = await createTerminalGpuRendererAsync(canvas, {
      cols: 4,
      rows: 2,
    });

    expect(renderer.capabilities.backend).toBe('webgl2');
    expect(gl.viewport).toHaveBeenCalled();
  });

  it('async WebGPU probe acquires and releases a device before falling back', async () => {
    const destroy = vi.fn();
    const requestDevice = vi.fn(async () => ({ destroy }));
    const requestAdapter = vi.fn(async () => ({ requestDevice }));
    vi.stubGlobal('navigator', { gpu: { requestAdapter } });
    const gl = fakeWebGl2Context();
    const canvas = fakeCanvas({ webgpu: {}, webgl2: gl, '2d': fakeCanvasContext2d() });

    const renderer = await createTerminalGpuRendererAsync(canvas, {
      cols: 4,
      rows: 2,
    });

    expect(requestAdapter).toHaveBeenCalledTimes(1);
    expect(requestDevice).toHaveBeenCalledTimes(1);
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(renderer.capabilities.backend).toBe('webgl2');
  });

  it('falls back to Canvas when the WebGL2 context is already lost', () => {
    const gl = fakeWebGl2Context({ lost: true });
    const canvas = fakeCanvas({ webgl2: gl, '2d': fakeCanvasContext2d() });

    const renderer = createTerminalGpuRenderer(canvas, {
      cols: 4,
      rows: 2,
      preferredBackends: ['webgl2', 'canvas2d'],
    });

    expect(renderer.capabilities.backend).toBe('canvas2d');
    expect(gl.viewport).not.toHaveBeenCalled();
  });

  it('clears a new WebGL2 canvas to the terminal background during construction', () => {
    const gl = fakeWebGl2Context();
    const canvas = fakeCanvas({ webgl2: gl });

    createTerminalGpuRenderer(canvas, {
      cols: 4,
      rows: 1,
      cellWidth: 8,
      cellHeight: 10,
      background: '#112233',
    });

    expect(gl.clearColor).toHaveBeenCalledWith(0x11 / 255, 0x22 / 255, 0x33 / 255, 1);
    expect(gl.clear).toHaveBeenCalledWith(gl.COLOR_BUFFER_BIT);
  });

  it('clears and draws a WebGL2 terminal frame', () => {
    const gl = fakeWebGl2Context();
    const canvas = fakeCanvas({ webgl2: gl });
    const renderer = createTerminalGpuRenderer(canvas, {
      cols: 4,
      rows: 1,
      cellWidth: 8,
      cellHeight: 10,
    });

    renderer.clear('#112233');
    renderer.paintFrame({
      dirty: 'full',
      rows: [
        {
          index: 0,
          dirty: true,
          cells: [
            { col: 0, text: 'A' },
            { col: 1, text: '█', fg: '#ff0000' },
          ],
        },
      ],
      cursor: { visible: false, row: 0, col: 0, position: { row: 0, col: 0 } },
    });

    expect(gl.clearColor).toHaveBeenLastCalledWith(0x11 / 255, 0x22 / 255, 0x33 / 255, 1);
    expect(gl.clear).toHaveBeenCalledWith(gl.COLOR_BUFFER_BIT);
    expect(gl.texSubImage2D).toHaveBeenCalled();
    expect(gl.bufferData).toHaveBeenCalled();
    expect(gl.drawArrays).toHaveBeenCalled();
  });

  it('expands WebGL2 cell background geometry for wide cells', () => {
    const gl = fakeWebGl2Context();
    const canvas = fakeCanvas({ webgl2: gl });
    const renderer = createTerminalGpuRenderer(canvas, {
      cols: 4,
      rows: 1,
      cellWidth: 8,
      cellHeight: 10,
    });

    renderer.paintFrame({
      dirty: 'full',
      rows: [
        {
          index: 0,
          dirty: true,
          cells: [{ col: 1, width: 2, text: '界', bg: '#ff0000' }],
        },
      ],
      cursor: { visible: false, row: 0, col: 0, position: { row: 0, col: 0 } },
    });

    const rectUpload = gl.bufferData.mock.calls.find(
      call => call[1] instanceof Float32Array,
    )?.[1] as Float32Array | undefined;
    expect(rectUpload).toBeDefined();
    const redXs: number[] = [];
    for (let offset = 0; offset < (rectUpload?.length ?? 0); offset += 6) {
      const red = rectUpload?.[offset + 2] === 1;
      const green = rectUpload?.[offset + 3] === 0;
      const blue = rectUpload?.[offset + 4] === 0;
      if (red && green && blue) redXs.push(rectUpload[offset] ?? 0);
    }

    expect(Math.min(...redXs)).toBe(8);
    expect(Math.max(...redXs)).toBe(24);
  });

  it('positions WebGL2 wide right-half block glyphs from the full rendered width', () => {
    const gl = fakeWebGl2Context();
    const canvas = fakeCanvas({ webgl2: gl });
    const renderer = createTerminalGpuRenderer(canvas, {
      cols: 4,
      rows: 1,
      cellWidth: 8,
      cellHeight: 10,
    });

    renderer.paintFrame({
      dirty: 'full',
      rows: [
        {
          index: 0,
          dirty: true,
          cells: [{ col: 1, width: 2, text: '▐', fg: '#ff0000' }],
        },
      ],
      cursor: { visible: false, row: 0, col: 0, position: { row: 0, col: 0 } },
    });

    const rectUpload = gl.bufferData.mock.calls.find(
      call => call[1] instanceof Float32Array,
    )?.[1] as Float32Array | undefined;
    expect(rectUpload).toBeDefined();
    const redXs: number[] = [];
    for (let offset = 0; offset < (rectUpload?.length ?? 0); offset += 6) {
      const red = rectUpload?.[offset + 2] === 1;
      const green = rectUpload?.[offset + 3] === 0;
      const blue = rectUpload?.[offset + 4] === 0;
      if (red && green && blue) redXs.push(rectUpload[offset] ?? 0);
    }

    expect(Math.min(...redXs)).toBe(16);
    expect(Math.max(...redXs)).toBe(24);
  });

  it('draws a WebGL2 cursor on the tail column across the whole wide cell', () => {
    const gl = fakeWebGl2Context();
    const canvas = fakeCanvas({ webgl2: gl });
    const renderer = createTerminalGpuRenderer(canvas, {
      cols: 4,
      rows: 1,
      cellWidth: 8,
      cellHeight: 10,
    });

    renderer.paintFrame({
      dirty: 'full',
      colors: { cursor: '#00ff00' },
      rows: [
        {
          index: 0,
          dirty: true,
          cells: [{ col: 1, width: 2, text: '界' }],
        },
      ],
      cursor: { visible: true, row: 0, col: 2, position: { row: 0, col: 2 } },
    });

    const greenXs: number[] = [];
    for (const call of gl.bufferData.mock.calls) {
      const data = call[1];
      if (!(data instanceof Float32Array)) continue;
      for (let offset = 0; offset < data.length; offset += 6) {
        const red = data[offset + 2] === 0;
        const green = data[offset + 3] === 1;
        const blue = data[offset + 4] === 0;
        if (red && green && blue) greenXs.push(data[offset] ?? 0);
      }
    }

    expect(Math.min(...greenXs)).toBe(8);
    expect(Math.max(...greenXs)).toBe(24);
  });

  it('uses italic atlas glyphs for italic WebGL2 terminal cells', () => {
    const fonts: string[] = [];
    vi.stubGlobal('document', {
      createElement: vi.fn(() => ({
        width: 0,
        height: 0,
        getContext: vi.fn(() => fakeCanvasContext2d({ fonts })),
      })),
    });
    const gl = fakeWebGl2Context();
    const canvas = fakeCanvas({ webgl2: gl });
    const renderer = createTerminalGpuRenderer(canvas, {
      cols: 4,
      rows: 1,
      cellWidth: 8,
      cellHeight: 10,
    });

    renderer.paintFrame({
      dirty: 'full',
      rows: [
        {
          index: 0,
          dirty: true,
          cells: [{ col: 0, text: 'i', style: { italic: true } }],
        },
      ],
      cursor: { visible: false, row: 0, col: 0, position: { row: 0, col: 0 } },
    });

    expect(fonts.some(font => font.startsWith('italic '))).toBe(true);
  });

  it('paints double underline WebGL2 terminal cells as two rules', () => {
    const gl = fakeWebGl2Context();
    const canvas = fakeCanvas({ webgl2: gl });
    const renderer = createTerminalGpuRenderer(canvas, {
      cols: 4,
      rows: 1,
      cellWidth: 8,
      cellHeight: 10,
    });

    renderer.paintFrame({
      dirty: 'full',
      rows: [
        {
          index: 0,
          dirty: true,
          cells: [
            {
              col: 1,
              width: 2,
              text: ' ',
              fg: '#ff0000',
              style: { underline: 'double' },
            },
          ],
        },
      ],
      cursor: { visible: false, row: 0, col: 0, position: { row: 0, col: 0 } },
    });

    const redYs = new Set<number>();
    for (const call of gl.bufferData.mock.calls) {
      const data = call[1];
      if (!(data instanceof Float32Array)) continue;
      for (let offset = 0; offset < data.length; offset += 6) {
        const red = data[offset + 2] === 1;
        const green = data[offset + 3] === 0;
        const blue = data[offset + 4] === 0;
        if (red && green && blue) redYs.add(data[offset + 1] ?? 0);
      }
    }

    expect(redYs.has(5)).toBe(true);
    expect(redYs.has(8)).toBe(true);
  });

  it('paints strikethrough and overline WebGL2 terminal cells', () => {
    const gl = fakeWebGl2Context();
    const canvas = fakeCanvas({ webgl2: gl });
    const renderer = createTerminalGpuRenderer(canvas, {
      cols: 4,
      rows: 1,
      cellWidth: 8,
      cellHeight: 10,
    });

    renderer.paintFrame({
      dirty: 'full',
      rows: [
        {
          index: 0,
          dirty: true,
          cells: [
            {
              col: 1,
              width: 2,
              text: ' ',
              fg: '#ff0000',
              style: { strikethrough: true, overline: true },
            },
          ],
        },
      ],
      cursor: { visible: false, row: 0, col: 0, position: { row: 0, col: 0 } },
    });

    const redYs = new Set<number>();
    for (const call of gl.bufferData.mock.calls) {
      const data = call[1];
      if (!(data instanceof Float32Array)) continue;
      for (let offset = 0; offset < data.length; offset += 6) {
        const red = data[offset + 2] === 1;
        const green = data[offset + 3] === 0;
        const blue = data[offset + 4] === 0;
        if (red && green && blue) redYs.add(data[offset + 1] ?? 0);
      }
    }

    expect(redYs.has(5)).toBe(true);
    expect(redYs.has(1)).toBe(true);
  });

  it('dims faint WebGL2 terminal glyphs', () => {
    const gl = fakeWebGl2Context();
    const canvas = fakeCanvas({ webgl2: gl });
    const renderer = createTerminalGpuRenderer(canvas, {
      cols: 4,
      rows: 1,
      cellWidth: 8,
      cellHeight: 10,
    });

    renderer.paintFrame({
      dirty: 'full',
      rows: [
        {
          index: 0,
          dirty: true,
          cells: [{ col: 0, text: 'f', fg: '#ff0000', style: { faint: true } }],
        },
      ],
      cursor: { visible: false, row: 0, col: 0, position: { row: 0, col: 0 } },
    });

    const faintGlyphUpload = gl.bufferData.mock.calls.some(call => {
      const data = call[1];
      if (!(data instanceof Float32Array) || data.length % 8 !== 0) return false;
      for (let offset = 0; offset < data.length; offset += 8) {
        const red = data[offset + 4] === 1;
        const green = data[offset + 5] === 0;
        const blue = data[offset + 6] === 0;
        const alpha = Math.abs((data[offset + 7] ?? 0) - 0.55) < 0.0001;
        if (red && green && blue && alpha) return true;
      }
      return false;
    });

    expect(faintGlyphUpload).toBe(true);
  });

  it('skips invisible WebGL2 terminal glyphs', () => {
    const gl = fakeWebGl2Context();
    const canvas = fakeCanvas({ webgl2: gl });
    const renderer = createTerminalGpuRenderer(canvas, {
      cols: 4,
      rows: 1,
      cellWidth: 8,
      cellHeight: 10,
    });

    renderer.takeStats?.();
    renderer.paintFrame({
      dirty: 'full',
      rows: [
        {
          index: 0,
          dirty: true,
          cells: [{ col: 0, text: 'i', fg: '#ff0000', style: { invisible: true } }],
        },
      ],
      cursor: { visible: false, row: 0, col: 0, position: { row: 0, col: 0 } },
    });

    expect(renderer.takeStats?.()?.glyphsPainted).toBe(0);
  });

  it('does not draw a WebGL2 cursor on a row that was not repainted', () => {
    const gl = fakeWebGl2Context();
    const canvas = fakeCanvas({ webgl2: gl });
    const renderer = createTerminalGpuRenderer(canvas, {
      cols: 4,
      rows: 2,
      cellWidth: 8,
      cellHeight: 10,
    });

    renderer.paintFrame({
      dirty: 'partial',
      colors: { cursor: '#00ff00' },
      rows: [{ index: 1, dirty: true, cells: [{ col: 0, text: 'A' }] }],
      cursor: { visible: true, row: 0, col: 0, position: { row: 0, col: 0 } },
    });

    const hasGreenUpload = gl.bufferData.mock.calls.some(call => {
      const data = call[1];
      if (!(data instanceof Float32Array)) return false;
      for (let offset = 0; offset < data.length; offset += 6) {
        if (data[offset + 2] === 0 && data[offset + 3] === 1 && data[offset + 4] === 0) {
          return true;
        }
      }
      return false;
    });

    expect(hasGreenUpload).toBe(false);
  });

  it('scissor-clears translucent rows before repainting partial WebGL2 rows', () => {
    const gl = fakeWebGl2Context();
    const canvas = fakeCanvas({ webgl2: gl });
    const renderer = createTerminalGpuRenderer(canvas, {
      cols: 4,
      rows: 2,
      cellWidth: 8,
      cellHeight: 10,
      backgroundOpacity: 0.4,
    });
    gl.clear.mockClear();

    renderer.paintFrame({
      dirty: 'partial',
      rows: [{ index: 1, dirty: true, cells: [{ col: 0, text: 'A' }] }],
      cursor: { visible: false, row: 0, col: 0, position: { row: 0, col: 0 } },
    });

    expect(gl.enable).toHaveBeenCalledWith(gl.SCISSOR_TEST);
    expect(gl.scissor).toHaveBeenCalledTimes(1);
    expect(gl.scissor).toHaveBeenCalledWith(0, 0, 32, 10);
    expect(gl.clearColor).toHaveBeenCalledWith(0, 0, 0, 0);
    expect(gl.clear).toHaveBeenCalledWith(gl.COLOR_BUFFER_BIT);
    expect(gl.disable).toHaveBeenCalledWith(gl.SCISSOR_TEST);
  });

  it('reports WebGL2 paint and glyph-atlas stats as deltas', () => {
    const gl = fakeWebGl2Context();
    const canvas = fakeCanvas({ webgl2: gl });
    const renderer = createTerminalGpuRenderer(canvas, {
      cols: 4,
      rows: 1,
      cellWidth: 8,
      cellHeight: 10,
    });

    renderer.takeStats?.();
    renderer.clear('#112233');
    renderer.paintFrame({
      dirty: 'full',
      rows: [
        {
          index: 0,
          dirty: true,
          cells: [
            { col: 0, text: 'A' },
            { col: 1, text: 'A' },
            { col: 2, text: '█' },
          ],
        },
      ],
      cursor: { visible: false, row: 0, col: 0, position: { row: 0, col: 0 } },
    });

    const stats = renderer.takeStats?.();
    expect(stats).toEqual(
      expect.objectContaining({
        backend: 'webgl2',
        clears: 1,
        paints: 1,
        rowsPainted: 1,
        cellsPainted: 3,
        glyphsPainted: 2,
        blockGlyphsPainted: 1,
        glyphAtlasMisses: 1,
        glyphAtlasHits: 1,
        glyphAtlasUploads: 1,
        rectDrawCalls: 1,
        glyphDrawCalls: 1,
      }),
    );
    expect(stats?.drawCalls).toBe(2);
    expect(renderer.takeStats?.()?.paints).toBe(0);
  });

  it('adds atlas pages instead of resetting when a WebGL2 paint exhausts one page', () => {
    const gl = fakeWebGl2Context();
    const canvas = fakeCanvas({ webgl2: gl });
    const renderer = createTerminalGpuRenderer(canvas, {
      cols: 6,
      rows: 1,
      cellWidth: 1024,
      cellHeight: 1024,
    });

    renderer.takeStats?.();
    renderer.paintFrame({
      dirty: 'full',
      rows: [
        {
          index: 0,
          dirty: true,
          cells: [
            { col: 0, text: 'A' },
            { col: 1, text: 'B' },
            { col: 2, text: 'C' },
            { col: 3, text: 'D' },
            { col: 4, text: 'E' },
            { col: 5, text: 'F' },
          ],
        },
      ],
      cursor: { visible: false, row: 0, col: 0, position: { row: 0, col: 0 } },
    });

    const stats = renderer.takeStats?.();
    expect(stats).toEqual(
      expect.objectContaining({
        glyphAtlasMisses: 6,
        glyphAtlasUploads: 6,
        glyphAtlasResets: 0,
        glyphDrawCalls: 2,
      }),
    );
    expect(gl.createTexture).toHaveBeenCalledTimes(2);
  });

  it('releases WebGL2 resources when disposed', () => {
    const gl = fakeWebGl2Context();
    const canvas = fakeCanvas({ webgl2: gl });
    const renderer = createTerminalGpuRenderer(canvas, {
      cols: 4,
      rows: 1,
      cellWidth: 8,
      cellHeight: 10,
    });
    gl.clear.mockClear();

    renderer.dispose?.();
    renderer.dispose?.();
    renderer.clear('#112233');
    renderer.paintFrame({
      dirty: 'full',
      rows: [{ index: 0, dirty: true, cells: [{ col: 0, text: 'A' }] }],
      cursor: { visible: false, row: 0, col: 0, position: { row: 0, col: 0 } },
    });

    expect(gl.deleteBuffer).toHaveBeenCalledTimes(2);
    expect(gl.deleteProgram).toHaveBeenCalledTimes(2);
    expect(gl.deleteFramebuffer).not.toHaveBeenCalled();
    expect(gl.deleteTexture).toHaveBeenCalledTimes(1);
    expect(gl.clear).not.toHaveBeenCalled();
    expect(gl.drawArrays).not.toHaveBeenCalled();
  });

  it('throws when no requested backend can initialize', () => {
    const canvas = fakeCanvas({});

    expect(() =>
      createTerminalGpuRenderer(canvas, {
        preferredBackends: ['canvas2d'],
      }),
    ).toThrow(/No terminal renderer backend could initialize/u);
  });
});
