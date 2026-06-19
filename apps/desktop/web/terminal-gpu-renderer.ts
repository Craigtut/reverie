import {
  TERMINAL_SURFACE,
  createTerminalCanvasRenderer,
  type TerminalCanvasOptions,
} from './terminal-canvas-renderer';
import type {
  TerminalCell,
  TerminalColor,
  TerminalFrame,
  TerminalOverlay,
  TerminalRenderer,
  TerminalRendererBackend,
  TerminalRendererCapabilities,
  TerminalRendererStats,
  TerminalRow,
  TerminalUnderlineStyle,
} from './terminalTypes';
import {
  blockElementGlyph,
  boxArcThickness,
  boxDrawingRects,
  isBoxArcGlyph,
  strokeBoxArc,
} from './terminal/boxDrawing';
import { terminalCellAtColumn, terminalCellWidth } from './terminal/cellGeometry';

const DEFAULT_FONT_FAMILY = 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';
const DEFAULT_FONT_SIZE = 14;
const DEFAULT_FOREGROUND = '#e8e1d7';
const DEFAULT_BACKGROUND = '#060605';
const DEFAULT_BACKGROUND_OPACITY = 1;
const SELECTION_ALPHA = 0.38;
const FAINT_ALPHA = 0.55;
const LINK_UNDERLINE_HEIGHT = 1;
const HOVER_LINK_UNDERLINE_HEIGHT = 2;
const ATLAS_SIZE = 2048;
const MAX_GLYPH_ATLAS_PAGES = 8;
export const DEFAULT_TERMINAL_RENDERER_BACKENDS: TerminalRendererBackend[] = ['webgl2', 'canvas2d'];
export const DEFAULT_TERMINAL_ASYNC_RENDERER_BACKENDS: TerminalRendererBackend[] = [
  'webgpu',
  'webgl2',
  'canvas2d',
];
const WEBGL2_RENDERER_CAPABILITIES: TerminalRendererCapabilities = {
  backend: 'webgl2',
  gpuAccelerated: true,
  fallback: false,
  explicitResourceManagement: true,
  retainedPartialPaint: true,
};

export interface TerminalRendererFactoryOptions extends TerminalCanvasOptions {
  preferredBackends?: TerminalRendererBackend[];
}

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

interface Glyph {
  page: number;
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}

interface WebGpuNavigator {
  gpu?: {
    requestAdapter: () => Promise<WebGpuAdapter | null>;
  };
}

interface WebGpuAdapter {
  requestDevice: () => Promise<WebGpuDevice>;
}

interface WebGpuDevice {
  destroy?: () => void;
}

export function createTerminalGpuRenderer(
  canvas: HTMLCanvasElement,
  options: TerminalRendererFactoryOptions = {},
): TerminalRenderer {
  const errors: string[] = [];
  for (const backend of terminalRendererBackendPlan(options.preferredBackends, {
    allowWebGpu: false,
    fallbackBackends: DEFAULT_TERMINAL_RENDERER_BACKENDS,
  })) {
    try {
      if (backend === 'webgl2') return createTerminalWebGl2Renderer(canvas, options);
      return createTerminalCanvasFallbackRenderer(canvas, options);
    } catch (error) {
      errors.push(`${backend}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`No terminal renderer backend could initialize (${errors.join('; ')})`);
}

export async function createTerminalGpuRendererAsync(
  canvas: HTMLCanvasElement,
  options: TerminalRendererFactoryOptions = {},
): Promise<TerminalRenderer> {
  const errors: string[] = [];
  for (const backend of terminalRendererBackendPlan(
    options.preferredBackends ?? DEFAULT_TERMINAL_ASYNC_RENDERER_BACKENDS,
    {
      allowWebGpu: true,
      fallbackBackends: DEFAULT_TERMINAL_ASYNC_RENDERER_BACKENDS,
    },
  )) {
    try {
      if (backend === 'webgpu') return await createTerminalWebGpuRendererAsync(canvas, options);
      if (backend === 'webgl2') return createTerminalWebGl2Renderer(canvas, options);
      return createTerminalCanvasFallbackRenderer(canvas, options);
    } catch (error) {
      errors.push(`${backend}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`No terminal renderer backend could initialize (${errors.join('; ')})`);
}

export function terminalRendererBackendPlan(
  preferredBackends: TerminalRendererBackend[] = DEFAULT_TERMINAL_RENDERER_BACKENDS,
  options: {
    allowWebGpu?: boolean;
    fallbackBackends?: readonly TerminalRendererBackend[];
  } = {},
): TerminalRendererBackend[] {
  const allowWebGpu = options.allowWebGpu ?? true;
  const fallbackBackends = options.fallbackBackends ?? DEFAULT_TERMINAL_RENDERER_BACKENDS;
  const out: TerminalRendererBackend[] = [];
  for (const backend of preferredBackends) {
    if (!isTerminalRendererBackend(backend) || out.includes(backend)) continue;
    if (backend === 'webgpu' && !allowWebGpu) continue;
    out.push(backend);
  }
  return out.length > 0 ? out : [...fallbackBackends];
}

export function createTerminalWebGpuRenderer(
  _canvas: HTMLCanvasElement,
  _options: TerminalCanvasOptions = {},
): TerminalRenderer {
  throw new Error('WebGPU terminal renderer requires the async renderer factory');
}

export async function createTerminalWebGpuRendererAsync(
  canvas: HTMLCanvasElement,
  _options: TerminalCanvasOptions = {},
): Promise<TerminalRenderer> {
  const device = await acquireTerminalWebGpuDevice(canvas);
  device.destroy?.();
  throw new Error('WebGPU terminal renderer is not implemented yet');
}

async function acquireTerminalWebGpuDevice(canvas: HTMLCanvasElement): Promise<WebGpuDevice> {
  const navigatorWithGpu = globalThis.navigator as WebGpuNavigator | undefined;
  if (!navigatorWithGpu?.gpu) {
    throw new Error('WebGPU navigator.gpu is unavailable');
  }
  const context = canvas.getContext('webgpu');
  if (!context) {
    throw new Error('WebGPU canvas context is unavailable');
  }
  const adapter = await navigatorWithGpu.gpu.requestAdapter();
  if (!adapter) {
    throw new Error('WebGPU adapter is unavailable');
  }
  return adapter.requestDevice();
}

export function createTerminalWebGl2Renderer(
  canvas: HTMLCanvasElement,
  options: TerminalCanvasOptions = {},
): TerminalRenderer {
  const cols = options.cols ?? TERMINAL_SURFACE.cols;
  const rows = options.rows ?? TERMINAL_SURFACE.rows;
  const cellWidth = options.cellWidth ?? TERMINAL_SURFACE.cellWidth;
  const cellHeight = options.cellHeight ?? TERMINAL_SURFACE.cellHeight;
  const fontSize = options.fontSize ?? DEFAULT_FONT_SIZE;
  const fontFamily = options.fontFamily ?? DEFAULT_FONT_FAMILY;
  const baseline = options.baseline ?? TERMINAL_SURFACE.baseline;
  const defaultForeground = colorToRgba(options.foreground, DEFAULT_FOREGROUND);
  // `defaultBackground` is the terminal's default background *color*. It is kept
  // fully opaque because it is reused as a draw color (inverse-cell foreground,
  // the glyph under a block cursor). How opaquely that color FILLS the canvas is
  // a separate knob, `backgroundAlpha`: at < 1 the canvas is alpha-backed and the
  // CSS-painted panel behind it (.terminal-canvas's own --terminal-bg) shows
  // through for default cells, putting the default background on the same paint
  // path as the surrounding shell.
  const defaultBackground = colorToRgba(options.background, DEFAULT_BACKGROUND);
  const backgroundAlpha = Math.min(
    1,
    Math.max(0, options.backgroundOpacity ?? DEFAULT_BACKGROUND_OPACITY),
  );
  // The fill used to clear/underlay the canvas: the default color at the
  // configured alpha. Distinct from `defaultBackground` so that stays opaque
  // wherever it is drawn as a glyph or inverse color.
  const defaultBackgroundFill: Rgba = { ...defaultBackground, a: backgroundAlpha };
  const defaultCursor = colorToRgba(options.cursor, options.foreground ?? DEFAULT_FOREGROUND);
  const dpr = window.devicePixelRatio || 1;
  const context = canvas.getContext('webgl2', {
    alpha: backgroundAlpha < 1,
    antialias: false,
    depth: false,
    stencil: false,
    // The terminal does not repaint continuously. Without preservation the
    // browser may discard the presented framebuffer between composites, which
    // can make a perfectly valid retained terminal model show up as blank
    // canvas pixels after resize or tab visibility changes.
    preserveDrawingBuffer: true,
  });

  if (!context) throw new Error('WebGL2 context is unavailable');
  if (context.isContextLost()) throw new Error('WebGL2 context is lost');
  const gl: WebGL2RenderingContext = context;

  canvas.width = cols * cellWidth * dpr;
  canvas.height = rows * cellHeight * dpr;
  canvas.style.width = `${cols * cellWidth}px`;
  canvas.style.height = `${rows * cellHeight}px`;

  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.disable(gl.DEPTH_TEST);
  gl.enable(gl.BLEND);
  // Separate alpha factors so the canvas's own alpha channel accumulates as
  // src.a + dst.a*(1-src.a). When the default background is translucent the
  // canvas is composited over the CSS panel behind it, so the alpha channel has
  // to be correct (plain SRC_ALPHA for alpha would store coverage^2 and bleed the
  // panel through glyph antialiasing). RGB blending is unchanged, so opaque mode,
  // where the alpha channel is ignored at composite, behaves exactly as before.
  gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

  const rectProgram = createProgram(gl, RECT_VERTEX_SHADER, RECT_FRAGMENT_SHADER);
  const glyphProgram = createProgram(gl, GLYPH_VERTEX_SHADER, GLYPH_FRAGMENT_SHADER);
  const rectBuffer = gl.createBuffer();
  const glyphBuffer = gl.createBuffer();
  if (!rectBuffer || !glyphBuffer) throw new Error('WebGL buffer allocation failed');
  const rectLocations = {
    position: requiredAttrib(gl, rectProgram, 'a_position'),
    color: requiredAttrib(gl, rectProgram, 'a_color'),
    resolution: requiredUniform(gl, rectProgram, 'u_resolution'),
  };
  const glyphLocations = {
    position: requiredAttrib(gl, glyphProgram, 'a_position'),
    uv: requiredAttrib(gl, glyphProgram, 'a_uv'),
    color: requiredAttrib(gl, glyphProgram, 'a_color'),
    resolution: requiredUniform(gl, glyphProgram, 'u_resolution'),
    atlas: requiredUniform(gl, glyphProgram, 'u_atlas'),
  };
  const rectVertexArray = createRectVertexArray();
  const glyphVertexArray = createGlyphVertexArray();
  bindDrawingBuffer();
  setClearColor(defaultBackgroundFill);
  gl.clear(gl.COLOR_BUFFER_BIT);
  flushDrawingBuffer();
  let stats = emptyRendererStats('webgl2');

  const atlas = createGlyphAtlas(
    gl,
    {
      cellWidth,
      cellHeight,
      dpr,
      fontFamily,
      fontSize,
      baseline,
    },
    () => stats,
  );
  const underlayRects = new VertexBatch(8192);
  const glyphBatches: Array<VertexBatch | undefined> = [];
  const foregroundRects = new VertexBatch(2048);
  const cursorGlyphBatches: Array<VertexBatch | undefined> = [];
  const overlayRects = new VertexBatch(1024);
  let disposed = false;

  function colorToCss(color: TerminalColor | undefined, fallback: string) {
    if (!color) return fallback;
    if (typeof color === 'string') return color;
    return `rgb(${color.r}, ${color.g}, ${color.b})`;
  }

  function rowsToPaint(frame: TerminalFrame): TerminalRow[] {
    if (frame.dirty === 'clean') return [];
    if (frame.dirty === 'full') return frame.rows;
    return frame.rows.filter(row => row.dirty);
  }

  function rowRect(row: number, color: Rgba, rects: VertexBatch) {
    pushRect(rects, 0, row * cellHeight, cols * cellWidth, cellHeight, color);
  }

  // The drawing buffer is premultiplied-alpha; a clear value is written raw (it
  // does not go through the blend stage), so premultiply it here to match how the
  // canvas is composited. At alpha 1 this is the identity, so opaque mode is
  // unchanged; at alpha 0 it clears to true transparent (0,0,0,0).
  function setClearColor(color: Rgba) {
    gl.clearColor(color.r * color.a, color.g * color.a, color.b * color.a, color.a);
  }

  function clear(background?: TerminalColor) {
    if (disposed) return;
    stats.clears += 1;
    const color = colorToRgba(colorToCss(background, options.background ?? DEFAULT_BACKGROUND));
    color.a = backgroundAlpha;
    bindDrawingBuffer();
    setClearColor(color);
    gl.clear(gl.COLOR_BUFFER_BIT);
    flushDrawingBuffer();
  }

  function paintFrame(frame: TerminalFrame, overlay?: TerminalOverlay) {
    if (disposed) return;
    const paintRows = rowsToPaint(frame);
    if (paintRows.length === 0 && !overlay) return;
    const cellsPainted = paintRows.reduce((sum, row) => sum + row.cells.length, 0);
    stats.paints += 1;
    stats.rowsPainted += paintRows.length;
    stats.cellsPainted += cellsPainted;
    stats.maxRowsPerPaint = Math.max(stats.maxRowsPerPaint, paintRows.length);
    stats.maxCellsPerPaint = Math.max(stats.maxCellsPerPaint, cellsPainted);

    let attempts = 0;
    while (attempts < 2) {
      attempts += 1;
      const atlasGeneration = atlas.generation();
      underlayRects.clear();
      clearBatches(glyphBatches);
      foregroundRects.clear();
      clearBatches(cursorGlyphBatches);
      overlayRects.clear();

      for (const row of paintRows) {
        // Only lay down the default-background underlay when it is at least
        // partly opaque. At alpha 0 the CSS panel behind the canvas is the
        // background, so a transparent underlay rect would be wasted work; the
        // dirty row is still cleared to transparent by clearTranslucentRows.
        if (backgroundAlpha > 0) {
          rowRect(row.index, defaultBackgroundFill, underlayRects);
        }
        for (const cell of row.cells) {
          paintCell(cell, row.index, underlayRects, glyphBatches, foregroundRects);
        }
      }

      const paintedRowIndexes = new Set(paintRows.map(row => row.index));
      paintCursor(frame, foregroundRects, cursorGlyphBatches, paintedRowIndexes);
      paintOverlay(overlay, overlayRects, paintedRowIndexes);
      if (atlas.generation() !== atlasGeneration) continue;

      bindDrawingBuffer();
      clearTranslucentRows(paintRows);
      drawRects(underlayRects);
      drawGlyphBatches(glyphBatches);
      drawRects(foregroundRects);
      drawGlyphBatches(cursorGlyphBatches);
      drawRects(overlayRects);
      flushDrawingBuffer();
      return;
    }

    // A reset during the retry means the frame itself overflowed all atlas
    // pages. Paint the latest rebuilt batches so the retained drawing buffer
    // still converges instead of leaving cleared rows behind.
    bindDrawingBuffer();
    clearTranslucentRows(paintRows);
    drawRects(underlayRects);
    drawGlyphBatches(glyphBatches);
    drawRects(foregroundRects);
    drawGlyphBatches(cursorGlyphBatches);
    drawRects(overlayRects);
    flushDrawingBuffer();
  }

  function clearBatches(batches: readonly (VertexBatch | undefined)[]) {
    for (const batch of batches) {
      batch?.clear();
    }
  }

  function glyphBatch(
    batches: Array<VertexBatch | undefined>,
    page: number,
    initialCapacity: number,
  ) {
    let batch = batches[page];
    if (!batch) {
      batch = new VertexBatch(initialCapacity);
      batches[page] = batch;
    }
    return batch;
  }

  function drawGlyphBatches(batches: readonly (VertexBatch | undefined)[]) {
    for (let page = 0; page < batches.length; page += 1) {
      const batch = batches[page];
      if (!batch || batch.length === 0) continue;
      const texture = atlas.texture(page);
      if (!texture) continue;
      drawGlyphs(batch, texture);
    }
  }

  function createRectVertexArray() {
    const vertexArray = gl.createVertexArray();
    if (!vertexArray) throw new Error('WebGL vertex array allocation failed');
    const stride = 6 * Float32Array.BYTES_PER_ELEMENT;
    gl.bindVertexArray(vertexArray);
    gl.bindBuffer(gl.ARRAY_BUFFER, rectBuffer);
    gl.enableVertexAttribArray(rectLocations.position);
    gl.vertexAttribPointer(rectLocations.position, 2, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(rectLocations.color);
    gl.vertexAttribPointer(
      rectLocations.color,
      4,
      gl.FLOAT,
      false,
      stride,
      2 * Float32Array.BYTES_PER_ELEMENT,
    );
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    return vertexArray;
  }

  function createGlyphVertexArray() {
    const vertexArray = gl.createVertexArray();
    if (!vertexArray) throw new Error('WebGL vertex array allocation failed');
    const stride = 8 * Float32Array.BYTES_PER_ELEMENT;
    gl.bindVertexArray(vertexArray);
    gl.bindBuffer(gl.ARRAY_BUFFER, glyphBuffer);
    gl.enableVertexAttribArray(glyphLocations.position);
    gl.vertexAttribPointer(glyphLocations.position, 2, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(glyphLocations.uv);
    gl.vertexAttribPointer(
      glyphLocations.uv,
      2,
      gl.FLOAT,
      false,
      stride,
      2 * Float32Array.BYTES_PER_ELEMENT,
    );
    gl.enableVertexAttribArray(glyphLocations.color);
    gl.vertexAttribPointer(
      glyphLocations.color,
      4,
      gl.FLOAT,
      false,
      stride,
      4 * Float32Array.BYTES_PER_ELEMENT,
    );
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    return vertexArray;
  }

  function bindDrawingBuffer() {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  function flushDrawingBuffer() {
    gl.flush();
  }

  function clearTranslucentRows(paintRows: readonly TerminalRow[]) {
    if (backgroundAlpha >= 1 || paintRows.length === 0) return;
    gl.clearColor(0, 0, 0, 0);

    const rowHeightPx = cellHeight * dpr;
    const width = Math.round(cols * cellWidth * dpr);
    if (!Number.isInteger(rowHeightPx)) {
      gl.enable(gl.SCISSOR_TEST);
      for (const row of paintRows) {
        const x = 0;
        const y = Math.max(0, Math.round(canvas.height - (row.index + 1) * cellHeight * dpr));
        const height = Math.round(cellHeight * dpr);
        gl.scissor(x, y, width, height);
        gl.clear(gl.COLOR_BUFFER_BIT);
      }
      gl.disable(gl.SCISSOR_TEST);
      return;
    }

    const rowIndexes = Array.from(new Set(paintRows.map(row => row.index))).sort((a, b) => a - b);
    if (
      rowIndexes.length >= rows &&
      rowIndexes[0] === 0 &&
      rowIndexes[rowIndexes.length - 1] === rows - 1
    ) {
      gl.clear(gl.COLOR_BUFFER_BIT);
      return;
    }

    gl.enable(gl.SCISSOR_TEST);
    for (let i = 0; i < rowIndexes.length; ) {
      const start = rowIndexes[i];
      let end = start;
      i += 1;
      while (i < rowIndexes.length && rowIndexes[i] === end + 1) {
        end = rowIndexes[i];
        i += 1;
      }
      const x = 0;
      const y = Math.max(0, Math.round(canvas.height - (end + 1) * rowHeightPx));
      const height = Math.round((end - start + 1) * rowHeightPx);
      gl.scissor(x, y, width, height);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.disable(gl.SCISSOR_TEST);
  }

  function paintCell(
    cell: TerminalCell,
    row: number,
    underlayRects: VertexBatch,
    glyphs: Array<VertexBatch | undefined>,
    foregroundRects: VertexBatch,
  ) {
    const x = cell.col * cellWidth;
    const y = row * cellHeight;
    const widthCells = terminalCellWidth(cell, cols);
    const drawWidth = widthCells * cellWidth;
    const inverse = Boolean(cell.style?.inverse);
    const fg = colorToRgba(cell.fg, options.foreground ?? DEFAULT_FOREGROUND);
    const bg = cell.bg ? colorToRgba(cell.bg, options.background ?? DEFAULT_BACKGROUND) : null;
    const foreground = cellForeground(cell, inverse ? (bg ?? defaultBackground) : fg);
    const background = inverse ? fg : bg;

    if (background) {
      pushRect(underlayRects, x, y, drawWidth, cellHeight, background);
    }
    if (!cell.style?.invisible) {
      if (
        cell.text &&
        cell.text !== ' ' &&
        !paintBlockGlyph(cell.text, x, y, drawWidth, foreground, underlayRects) &&
        !paintBoxGlyph(cell.text, x, y, drawWidth, foreground, underlayRects)
      ) {
        stats.glyphsPainted += 1;
        const glyph = atlas.glyph(cell.text, cellBold(cell), cellItalic(cell), widthCells);
        pushGlyph(
          glyphBatch(glyphs, glyph.page, 8192),
          glyph,
          x,
          y,
          drawWidth,
          cellHeight,
          foreground,
        );
      }
      const underline = underlineStyle(cell);
      if (underline) {
        pushCellUnderline(foregroundRects, x, y, drawWidth, cellHeight, underline, foreground);
      }
      if (cell.style?.strikethrough) {
        pushRect(foregroundRects, x, y + Math.floor(cellHeight / 2), drawWidth, 1, foreground);
      }
      if (cell.style?.overline) {
        pushRect(foregroundRects, x, y + 1, drawWidth, 1, foreground);
      }
    }
  }

  function paintBlockGlyph(
    text: string,
    x: number,
    y: number,
    width: number,
    color: Rgba,
    rects: VertexBatch,
  ) {
    const block = blockElementGlyph(text, x, y, width, cellHeight, dpr);
    if (!block) return false;
    const fill = block.alpha < 1 ? { ...color, a: color.a * block.alpha } : color;
    for (const rect of block.rects) {
      pushRect(rects, rect.x, rect.y, rect.width, rect.height, fill);
    }
    stats.blockGlyphsPainted += 1;
    return true;
  }

  // Draw box-drawing lines/junctions (─ │ ┌ ┼ ━ ═ …) as solid rects so they tile
  // edge to edge. Painting them from the font atlas leaves a sub-pixel gap at each
  // cell seam (the cell is wider than the glyph advance), which shows up as evenly
  // spaced dots along a straight rule.
  function paintBoxGlyph(
    text: string,
    x: number,
    y: number,
    width: number,
    color: Rgba,
    rects: VertexBatch,
  ) {
    const boxRects = boxDrawingRects(text, x, y, width, cellHeight, dpr);
    if (!boxRects) return false;
    for (const rect of boxRects) {
      pushRect(rects, rect.x, rect.y, rect.width, rect.height, color);
    }
    stats.blockGlyphsPainted += 1;
    return true;
  }

  function paintOverlay(
    overlay: TerminalOverlay | undefined,
    rects: VertexBatch,
    paintedRows: Set<number>,
  ) {
    if (!overlay) return;
    const selection = { ...defaultForeground, a: SELECTION_ALPHA };
    for (const span of overlay.selection ?? []) {
      if (!paintedRows.has(span.row)) continue;
      pushSpan(rects, span, cellWidth, cellHeight, selection);
    }
    for (const span of overlay.links ?? []) {
      if (!paintedRows.has(span.row)) continue;
      pushUnderline(rects, span, cellWidth, cellHeight, defaultForeground, LINK_UNDERLINE_HEIGHT);
    }
    if (overlay.hoverLink && paintedRows.has(overlay.hoverLink.row)) {
      pushUnderline(
        rects,
        overlay.hoverLink,
        cellWidth,
        cellHeight,
        defaultForeground,
        HOVER_LINK_UNDERLINE_HEIGHT,
      );
    }
  }

  function paintCursor(
    frame: TerminalFrame,
    rects: VertexBatch,
    glyphs: Array<VertexBatch | undefined>,
    paintedRows: ReadonlySet<number>,
  ) {
    const cursor = cursorPosition(frame.cursor);
    if (!frame.cursor?.visible || !cursor) return;
    if (!paintedRows.has(cursor.row)) return;
    const y = cursor.row * cellHeight;
    const cell = cellAt(frame, cursor.row, cursor.col, cols);
    const cursorCol = cell?.col ?? cursor.col;
    const x = cursorCol * cellWidth;
    const widthCells = terminalCellWidth(cell ?? { col: cursorCol }, cols);
    const drawWidth = widthCells * cellWidth;
    const cursorColor = colorToRgba(frame.colors?.cursor, options.cursor ?? options.foreground);
    if (!frame.colors?.cursor && !options.cursor) {
      cursorColor.r = defaultCursor.r;
      cursorColor.g = defaultCursor.g;
      cursorColor.b = defaultCursor.b;
      cursorColor.a = defaultCursor.a;
    }
    const style = frame.cursor.style ?? 'block';

    if (style === 'bar') {
      pushRect(rects, x, y + 1, 2, cellHeight - 2, cursorColor);
      return;
    }
    if (style === 'underline') {
      pushRect(rects, x, y + cellHeight - 3, drawWidth, 2, cursorColor);
      return;
    }
    if (style === 'block_hollow') {
      pushRect(rects, x, y, drawWidth, 1, cursorColor);
      pushRect(rects, x, y + cellHeight - 1, drawWidth, 1, cursorColor);
      pushRect(rects, x, y, 1, cellHeight, cursorColor);
      pushRect(rects, x + drawWidth - 1, y, 1, cellHeight, cursorColor);
      return;
    }

    pushRect(rects, x, y, drawWidth, cellHeight, cursorColor);
    if (cell?.text && cell.text !== ' ' && !cell.style?.invisible) {
      stats.glyphsPainted += 1;
      const glyph = atlas.glyph(cell.text, cellBold(cell), cellItalic(cell), widthCells);
      pushGlyph(
        glyphBatch(glyphs, glyph.page, 256),
        glyph,
        x,
        y,
        drawWidth,
        cellHeight,
        defaultBackground,
      );
    }
  }

  function drawRects(vertices: VertexBatch) {
    if (disposed) return;
    if (vertices.length === 0) return;
    const data = vertices.view();
    stats.drawCalls += 1;
    stats.rectDrawCalls += 1;
    stats.rectVertices += vertices.vertexCount(6);
    stats.bufferUploads += 1;
    stats.bufferUploadBytes += data.byteLength;
    // biome-ignore lint/correctness/useHookAtTopLevel: WebGL useProgram is not a React hook.
    gl.useProgram(rectProgram);
    gl.uniform2f(rectLocations.resolution, cols * cellWidth, rows * cellHeight);
    gl.bindVertexArray(rectVertexArray);
    gl.bindBuffer(gl.ARRAY_BUFFER, rectBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STREAM_DRAW);
    gl.drawArrays(gl.TRIANGLES, 0, vertices.vertexCount(6));
    gl.bindVertexArray(null);
  }

  function drawGlyphs(vertices: VertexBatch, texture: WebGLTexture) {
    if (disposed) return;
    if (vertices.length === 0) return;
    const data = vertices.view();
    stats.drawCalls += 1;
    stats.glyphDrawCalls += 1;
    stats.glyphVertices += vertices.vertexCount(8);
    stats.bufferUploads += 1;
    stats.bufferUploadBytes += data.byteLength;
    // biome-ignore lint/correctness/useHookAtTopLevel: WebGL useProgram is not a React hook.
    gl.useProgram(glyphProgram);
    gl.uniform2f(glyphLocations.resolution, cols * cellWidth, rows * cellHeight);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(glyphLocations.atlas, 0);
    gl.bindVertexArray(glyphVertexArray);
    gl.bindBuffer(gl.ARRAY_BUFFER, glyphBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STREAM_DRAW);
    gl.drawArrays(gl.TRIANGLES, 0, vertices.vertexCount(8));
    gl.bindVertexArray(null);
  }

  return {
    capabilities: WEBGL2_RENDERER_CAPABILITIES,
    cols,
    rows,
    cellWidth,
    cellHeight,
    clear,
    paintFrame,
    rowsToPaint,
    takeStats() {
      const out = stats;
      stats = emptyRendererStats('webgl2');
      return out;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      gl.deleteVertexArray(rectVertexArray);
      gl.deleteVertexArray(glyphVertexArray);
      gl.deleteBuffer(rectBuffer);
      gl.deleteBuffer(glyphBuffer);
      gl.deleteProgram(rectProgram);
      gl.deleteProgram(glyphProgram);
      atlas.dispose();
    },
  };
}

function createTerminalCanvasFallbackRenderer(
  canvas: HTMLCanvasElement,
  options: TerminalCanvasOptions,
): TerminalRenderer {
  return createTerminalCanvasRenderer(canvas, options);
}

function isTerminalRendererBackend(value: unknown): value is TerminalRendererBackend {
  return value === 'webgpu' || value === 'webgl2' || value === 'canvas2d';
}

function emptyRendererStats(backend: TerminalRendererBackend): TerminalRendererStats {
  return {
    backend,
    paints: 0,
    clears: 0,
    rowsPainted: 0,
    cellsPainted: 0,
    glyphsPainted: 0,
    blockGlyphsPainted: 0,
    drawCalls: 0,
    rectDrawCalls: 0,
    glyphDrawCalls: 0,
    rectVertices: 0,
    glyphVertices: 0,
    bufferUploads: 0,
    bufferUploadBytes: 0,
    glyphAtlasHits: 0,
    glyphAtlasMisses: 0,
    glyphAtlasUploads: 0,
    glyphAtlasResets: 0,
    maxRowsPerPaint: 0,
    maxCellsPerPaint: 0,
  };
}

class VertexBatch {
  private data: Float32Array;
  length = 0;

  constructor(initialCapacity: number) {
    this.data = new Float32Array(Math.max(1, initialCapacity));
  }

  clear() {
    this.length = 0;
  }

  push6(a: number, b: number, c: number, d: number, e: number, f: number) {
    this.ensure(6);
    const offset = this.length;
    this.data[offset] = a;
    this.data[offset + 1] = b;
    this.data[offset + 2] = c;
    this.data[offset + 3] = d;
    this.data[offset + 4] = e;
    this.data[offset + 5] = f;
    this.length = offset + 6;
  }

  push8(a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) {
    this.ensure(8);
    const offset = this.length;
    this.data[offset] = a;
    this.data[offset + 1] = b;
    this.data[offset + 2] = c;
    this.data[offset + 3] = d;
    this.data[offset + 4] = e;
    this.data[offset + 5] = f;
    this.data[offset + 6] = g;
    this.data[offset + 7] = h;
    this.length = offset + 8;
  }

  view(): Float32Array {
    return this.data.subarray(0, this.length);
  }

  vertexCount(floatsPerVertex: number) {
    return this.length / floatsPerVertex;
  }

  private ensure(additional: number) {
    const needed = this.length + additional;
    if (needed <= this.data.length) return;
    let nextLength = this.data.length;
    while (nextLength < needed) nextLength *= 2;
    const next = new Float32Array(nextLength);
    next.set(this.data.subarray(0, this.length));
    this.data = next;
  }
}

function createGlyphAtlas(
  gl: WebGL2RenderingContext,
  options: {
    cellWidth: number;
    cellHeight: number;
    dpr: number;
    fontFamily: string;
    fontSize: number;
    // Device-px baseline offset from the cell top. Glyphs rasterize on the
    // alphabetic baseline at this y so they sit centered in the cell.
    baseline: number;
  },
  statsRef: () => TerminalRendererStats,
) {
  const baseGlyphWidth = Math.ceil(options.cellWidth * options.dpr);
  const glyphHeight = Math.ceil(options.cellHeight * options.dpr);
  // Clamp the rasterization baseline into the (possibly atlas-clamped) glyph
  // slot so a tall cell never draws above or below its texture row.
  const glyphBaseline = Math.max(1, Math.min(glyphHeight, Math.round(options.baseline)));
  const uploadGlyphHeight = Math.min(glyphHeight, ATLAS_SIZE);
  const scratch = document.createElement('canvas');
  scratch.width = baseGlyphWidth;
  scratch.height = glyphHeight;
  const scratchContext = scratch.getContext('2d');
  if (!scratchContext) throw new Error('Glyph atlas canvas is unavailable');
  let scratchCtx: CanvasRenderingContext2D = scratchContext;
  configureScratchContext();

  const glyphs = new Map<string, Glyph>();
  const pages: Array<{ texture: WebGLTexture; nextX: number; nextY: number }> = [createPage()];
  let atlasGeneration = 0;

  function createPage() {
    const texture = gl.createTexture();
    if (!texture) throw new Error('Glyph atlas texture allocation failed');
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      ATLAS_SIZE,
      ATLAS_SIZE,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      null,
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return { texture, nextX: 0, nextY: 0 };
  }

  function resetAtlas() {
    statsRef().glyphAtlasResets += 1;
    atlasGeneration += 1;
    glyphs.clear();
    for (const page of pages.splice(1)) {
      gl.deleteTexture(page.texture);
    }
    pages[0].nextX = 0;
    pages[0].nextY = 0;
    gl.bindTexture(gl.TEXTURE_2D, pages[0].texture);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      ATLAS_SIZE,
      ATLAS_SIZE,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      null,
    );
  }

  function configureScratchContext() {
    // Glyphs rasterize on the alphabetic baseline (placed at glyphBaseline) so
    // they sit centered in the cell, matching the cell metrics; box-arc strokes
    // draw in absolute coordinates and ignore the text baseline.
    scratchCtx.textBaseline = 'alphabetic';
    scratchCtx.fillStyle = '#ffffff';
  }

  function ensureScratchSize(width: number) {
    if (scratch.width === width && scratch.height === uploadGlyphHeight) return;
    scratch.width = width;
    scratch.height = uploadGlyphHeight;
    const context = scratch.getContext('2d');
    if (!context) throw new Error('Glyph atlas canvas is unavailable');
    scratchCtx = context;
    configureScratchContext();
  }

  function allocateGlyphSlot(glyphWidth: number) {
    const pageIndex = pages.length - 1;
    let page = pages[pageIndex];
    if (page.nextX + glyphWidth > ATLAS_SIZE) {
      page.nextX = 0;
      page.nextY += uploadGlyphHeight;
    }
    if (page.nextY + uploadGlyphHeight <= ATLAS_SIZE) {
      return { page, pageIndex };
    }
    if (pages.length < MAX_GLYPH_ATLAS_PAGES) {
      page = createPage();
      pages.push(page);
      return { page, pageIndex: pages.length - 1 };
    }
    resetAtlas();
    return { page: pages[0], pageIndex: 0 };
  }

  function glyph(text: string, bold: boolean, italic: boolean, widthCells = 1): Glyph {
    const width = Math.max(1, Math.floor(widthCells));
    const glyphWidth = Math.min(ATLAS_SIZE, baseGlyphWidth * width);
    const key = `${italic ? 'italic' : 'normal'}\0${bold ? '700' : '400'}\0${width}\0${text}`;
    const existing = glyphs.get(key);
    if (existing) {
      statsRef().glyphAtlasHits += 1;
      return existing;
    }
    statsRef().glyphAtlasMisses += 1;
    const { page, pageIndex } = allocateGlyphSlot(glyphWidth);

    ensureScratchSize(glyphWidth);
    scratchCtx.clearRect(0, 0, glyphWidth, uploadGlyphHeight);
    if (isBoxArcGlyph(text)) {
      // Rounded corners are stroked procedurally (a single anti-aliased path that
      // tiles into the straight rules), not taken from the text font.
      scratchCtx.strokeStyle = '#ffffff';
      strokeBoxArc(
        scratchCtx,
        text,
        0,
        0,
        glyphWidth,
        uploadGlyphHeight,
        boxArcThickness(options.dpr),
      );
    } else {
      scratchCtx.font = `${italic ? 'italic ' : ''}${bold ? '700' : '400'} ${
        options.fontSize * options.dpr
      }px ${options.fontFamily}`;
      // Center the glyph horizontally when the cell is narrower than the glyph's
      // advance (Ghostty's subpixel alignment for our SF Mono case): offset by
      // half the slack rather than clipping. For a full-width cell the slack is
      // ~0, so this is a no-op there. measureText is guarded for headless test
      // contexts that stub the 2D context without it.
      const advance =
        typeof scratchCtx.measureText === 'function'
          ? scratchCtx.measureText(text).width
          : glyphWidth;
      const offsetX = advance < glyphWidth ? (glyphWidth - advance) / 2 : 0;
      scratchCtx.fillText(text, offsetX, glyphBaseline);
    }
    gl.bindTexture(gl.TEXTURE_2D, page.texture);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, page.nextX, page.nextY, gl.RGBA, gl.UNSIGNED_BYTE, scratch);
    statsRef().glyphAtlasUploads += 1;

    const out = {
      page: pageIndex,
      u0: page.nextX / ATLAS_SIZE,
      v0: page.nextY / ATLAS_SIZE,
      u1: (page.nextX + glyphWidth) / ATLAS_SIZE,
      v1: (page.nextY + uploadGlyphHeight) / ATLAS_SIZE,
    };
    glyphs.set(key, out);
    page.nextX += glyphWidth;
    return out;
  }

  return {
    dispose() {
      for (const page of pages.splice(0)) {
        gl.deleteTexture(page.texture);
      }
    },
    generation() {
      return atlasGeneration;
    },
    glyph,
    texture(page: number) {
      return pages[page]?.texture ?? null;
    },
  };
}

function pushSpan(
  vertices: VertexBatch,
  span: { row: number; startCol: number; endCol: number },
  cellWidth: number,
  cellHeight: number,
  color: Rgba,
) {
  pushRect(
    vertices,
    span.startCol * cellWidth,
    span.row * cellHeight,
    (span.endCol - span.startCol) * cellWidth,
    cellHeight,
    color,
  );
}

function pushUnderline(
  vertices: VertexBatch,
  span: { row: number; startCol: number; endCol: number },
  cellWidth: number,
  cellHeight: number,
  color: Rgba,
  height: number,
) {
  pushRect(
    vertices,
    span.startCol * cellWidth,
    span.row * cellHeight + cellHeight - height,
    (span.endCol - span.startCol) * cellWidth,
    height,
    color,
  );
}

function pushCellUnderline(
  vertices: VertexBatch,
  x: number,
  y: number,
  width: number,
  cellHeight: number,
  style: TerminalUnderlineStyle,
  color: Rgba,
) {
  const baseline = y + cellHeight - 3;
  switch (style) {
    case 'double':
      pushRect(vertices, x, baseline - 2, width, 1, color);
      pushRect(vertices, x, baseline + 1, width, 1, color);
      break;
    case 'dotted':
      for (let offset = 0; offset < width; offset += 4) {
        pushRect(vertices, x + offset, baseline, Math.min(2, width - offset), 1, color);
      }
      break;
    case 'dashed':
      for (let offset = 0; offset < width; offset += 7) {
        pushRect(vertices, x + offset, baseline, Math.min(4, width - offset), 1, color);
      }
      break;
    case 'curly':
      for (let offset = 0; offset < width; offset += 4) {
        pushRect(
          vertices,
          x + offset,
          baseline + (offset % 8 === 0 ? 0 : 1),
          Math.min(2, width - offset),
          1,
          color,
        );
      }
      break;
    default:
      pushRect(vertices, x, baseline, width, 1, color);
  }
}

function pushRect(
  vertices: VertexBatch,
  x: number,
  y: number,
  width: number,
  height: number,
  color: Rgba,
) {
  if (width <= 0 || height <= 0) return;
  const x1 = x + width;
  const y1 = y + height;
  pushRectVertex(vertices, x, y, color);
  pushRectVertex(vertices, x1, y, color);
  pushRectVertex(vertices, x, y1, color);
  pushRectVertex(vertices, x, y1, color);
  pushRectVertex(vertices, x1, y, color);
  pushRectVertex(vertices, x1, y1, color);
}

function pushRectVertex(vertices: VertexBatch, x: number, y: number, color: Rgba) {
  vertices.push6(x, y, color.r, color.g, color.b, color.a);
}

function pushGlyph(
  vertices: VertexBatch,
  glyph: Glyph,
  x: number,
  y: number,
  cellWidth: number,
  cellHeight: number,
  color: Rgba,
) {
  const x1 = x + cellWidth;
  const y1 = y + cellHeight;
  pushGlyphVertex(vertices, x, y, glyph.u0, glyph.v0, color);
  pushGlyphVertex(vertices, x1, y, glyph.u1, glyph.v0, color);
  pushGlyphVertex(vertices, x, y1, glyph.u0, glyph.v1, color);
  pushGlyphVertex(vertices, x, y1, glyph.u0, glyph.v1, color);
  pushGlyphVertex(vertices, x1, y, glyph.u1, glyph.v0, color);
  pushGlyphVertex(vertices, x1, y1, glyph.u1, glyph.v1, color);
}

function pushGlyphVertex(
  vertices: VertexBatch,
  x: number,
  y: number,
  u: number,
  v: number,
  color: Rgba,
) {
  vertices.push8(x, y, u, v, color.r, color.g, color.b, color.a);
}

function underlineStyle(cell: TerminalCell): TerminalUnderlineStyle | null {
  if (cell.underline) return 'single';
  const underline = cell.style?.underline;
  if (!underline || underline === 'none') return null;
  return underline;
}

function cellForeground(cell: TerminalCell, color: Rgba): Rgba {
  if (!cell.style?.faint) return color;
  return { ...color, a: color.a * FAINT_ALPHA };
}

function cellBold(cell: TerminalCell) {
  return Boolean(cell.bold || cell.style?.bold);
}

function cellItalic(cell: TerminalCell) {
  return Boolean(cell.style?.italic);
}

function cursorPosition(cursor: TerminalFrame['cursor']) {
  if (!cursor) return null;
  if (cursor.position) return cursor.position;
  if (Number.isFinite(cursor.row) && Number.isFinite(cursor.col)) {
    return { row: cursor.row as number, col: cursor.col as number };
  }
  return null;
}

function cellAt(frame: TerminalFrame, rowIndex: number, col: number, cols: number) {
  return terminalCellAtColumn(
    frame.rows.find(row => row.index === rowIndex),
    col,
    cols,
  );
}

function colorToRgba(color: TerminalColor | undefined, fallback = DEFAULT_FOREGROUND): Rgba {
  if (!color) return cssToRgba(fallback);
  if (typeof color !== 'string')
    return { r: color.r / 255, g: color.g / 255, b: color.b / 255, a: 1 };
  return cssToRgba(color);
}

function cssToRgba(value: string): Rgba {
  if (value.startsWith('#')) {
    const hex = value.slice(1);
    if (hex.length === 3) {
      return {
        r: Number.parseInt(hex[0] + hex[0], 16) / 255,
        g: Number.parseInt(hex[1] + hex[1], 16) / 255,
        b: Number.parseInt(hex[2] + hex[2], 16) / 255,
        a: 1,
      };
    }
    if (hex.length >= 6) {
      return {
        r: Number.parseInt(hex.slice(0, 2), 16) / 255,
        g: Number.parseInt(hex.slice(2, 4), 16) / 255,
        b: Number.parseInt(hex.slice(4, 6), 16) / 255,
        a: 1,
      };
    }
  }

  const rgb = value.match(/rgba?\(([^)]+)\)/u);
  if (rgb) {
    const parts = rgb[1].split(',').map(part => Number.parseFloat(part.trim()));
    return {
      r: (parts[0] ?? 255) / 255,
      g: (parts[1] ?? 255) / 255,
      b: (parts[2] ?? 255) / 255,
      a: parts[3] ?? 1,
    };
  }

  return cssToRgba(DEFAULT_FOREGROUND);
}

function requiredUniform(
  gl: WebGL2RenderingContext,
  program: WebGLProgram,
  name: string,
): WebGLUniformLocation {
  const location = gl.getUniformLocation(program, name);
  if (!location) throw new Error(`Missing WebGL uniform ${name}`);
  return location;
}

function requiredAttrib(gl: WebGL2RenderingContext, program: WebGLProgram, name: string): number {
  const location = gl.getAttribLocation(program, name);
  if (location < 0) throw new Error(`Missing WebGL attribute ${name}`);
  return location;
}

function createProgram(
  gl: WebGL2RenderingContext,
  vertexSource: string,
  fragmentSource: string,
): WebGLProgram {
  const vertex = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  const program = gl.createProgram();
  if (!program) throw new Error('WebGL program allocation failed');
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(program) || 'WebGL program link failed');
  }
  return program;
}

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('WebGL shader allocation failed');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(shader) || 'WebGL shader compile failed');
  }
  return shader;
}

const RECT_VERTEX_SHADER = `#version 300 es
in vec2 a_position;
in vec4 a_color;
uniform vec2 u_resolution;
out vec4 v_color;
void main() {
  vec2 zero_to_one = a_position / u_resolution;
  vec2 clip = zero_to_one * 2.0 - 1.0;
  gl_Position = vec4(clip * vec2(1.0, -1.0), 0.0, 1.0);
  v_color = a_color;
}
`;

const RECT_FRAGMENT_SHADER = `#version 300 es
precision mediump float;
in vec4 v_color;
out vec4 out_color;
void main() {
  out_color = v_color;
}
`;

const GLYPH_VERTEX_SHADER = `#version 300 es
in vec2 a_position;
in vec2 a_uv;
in vec4 a_color;
uniform vec2 u_resolution;
out vec2 v_uv;
out vec4 v_color;
void main() {
  vec2 zero_to_one = a_position / u_resolution;
  vec2 clip = zero_to_one * 2.0 - 1.0;
  gl_Position = vec4(clip * vec2(1.0, -1.0), 0.0, 1.0);
  v_uv = a_uv;
  v_color = a_color;
}
`;

const GLYPH_FRAGMENT_SHADER = `#version 300 es
precision mediump float;
uniform sampler2D u_atlas;
in vec2 v_uv;
in vec4 v_color;
out vec4 out_color;
void main() {
  float alpha = texture(u_atlas, v_uv).a;
  out_color = vec4(v_color.rgb, v_color.a * alpha);
}
`;
