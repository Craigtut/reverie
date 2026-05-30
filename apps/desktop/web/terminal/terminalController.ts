import { createTerminalCanvasRenderer } from '../terminal-canvas-renderer';
import {
  SCROLL_FOLLOW_EPSILON_PX,
  frameForSurface,
  terminalInsetPx,
  type TerminalScrollMetrics,
  type TerminalSurface,
} from '../terminalScrollback';
import type { SessionTerminalView } from '../domain';
import type {
  TerminalFrame,
  TerminalModes,
  TerminalOverlay,
  TerminalRenderer,
} from '../terminalTypes';
import { buildSessionTerminalView, computePaintWindow, emptyTerminalView } from './frameModel';
import { rowPlainText, selectionText } from './interaction/selectionModel';
import { rowSpanInWindow, selectionWindowSpans } from './interaction/overlayPaint';
import { detectLinks } from './interaction/linkProvider';
import type { BufferCell, BufferLinkSpan, RowSpan, SelectionRange } from './interaction/types';
import { TERMINAL_THEME, type TerminalThemeColors } from '../themes/terminalTheme';

// The terminal's default background is painted as a solid, opaque panel in the
// active theme's surface color (set via setThemeColors). Opacity 1 keeps the
// fast non-alpha canvas; the surface is theme-matched rather than transparent so
// it reads as a calm solid panel and the default foreground stays legible in
// both light and dark.
const TERMINAL_BACKGROUND_OPACITY = 1;

export interface TerminalDomRefs {
  canvas: HTMLCanvasElement | null;
  viewport: HTMLDivElement | null;
  spacer: HTMLDivElement | null;
}

export interface TerminalControllerOptions {
  surface: TerminalSurface;
  // React-state sync callbacks (the controller stays framework-agnostic).
  onScrollbackRowCount: (count: number) => void;
  onLiveFollow: (live: boolean) => void;
  // Fired after a new composite frame is applied + painted. The find feature
  // uses it to re-map match spans to the (possibly scrolled) viewport.
  onComposite?: () => void;
  // Fired (deduped) when the scroll position/extent changes, so the custom
  // overlay scrollbar can reflect it in both the live and full-history views.
  onScrollMetrics?: (metrics: TerminalScrollMetrics) => void;
  // Injectable for tests; defaults to the real Canvas renderer.
  createRenderer?: (
    canvas: HTMLCanvasElement,
    surface: TerminalSurface,
    displayRows: number,
  ) => TerminalRenderer;
}

// The imperative terminal island: owns the Canvas renderer, the DOM elements,
// the live frame buffers, scroll/follow state, and the per-session view caches.
// Knows nothing about stores, services, sessions-as-domain, or React — it just
// paints. The hook (useTerminalSession) wires it to React + the stores and
// drives the session lifecycle.
export function createTerminalController(options: TerminalControllerOptions) {
  const { onScrollbackRowCount, onLiveFollow, onComposite, onScrollMetrics } = options;
  // The active theme's terminal colors. Seeded to dark (the app boots dark); the
  // hook pushes the live theme via setThemeColors on mount and on every switch.
  let themeColors: TerminalThemeColors = TERMINAL_THEME.dark;
  const createRenderer =
    options.createRenderer ??
    ((canvas, surface, displayRows) =>
      createTerminalCanvasRenderer(canvas, {
        ...surface,
        rows: displayRows,
        backgroundOpacity: TERMINAL_BACKGROUND_OPACITY,
        background: themeColors.background,
        foreground: themeColors.foreground,
      }));

  let els: TerminalDomRefs = { canvas: null, viewport: null, spacer: null };
  let surface: TerminalSurface = options.surface;
  let renderer: TerminalRenderer | null = null;
  let lastFrame: TerminalFrame | null = null;
  let lastComposite: TerminalFrame | null = null;
  let needsFullPaint = true;
  let lastStartRow: number | null = null;
  let liveFollow = true;
  let autoScrolling = false;
  // Interaction overlay state, all in buffer (composite-frame) coordinates so it
  // survives scrolling. The interaction controller drives these; paintWindow
  // translates them into window-local spans for the renderer.
  let selection: SelectionRange | null = null;
  let links: BufferLinkSpan[] = [];
  let hoverLink: BufferLinkSpan | null = null;
  // Find-in-terminal overlay state, also in buffer coordinates.
  let searchMatches: RowSpan[] = [];
  let activeMatch: RowSpan | null = null;
  // While find is navigating, pin the viewport (don't auto-jump to the tail on
  // new output) so the active match stays put.
  let searchActive = false;
  // History view: the composite is the full replayed transcript (deep history),
  // virtualized by the scroll spacer so the user can scroll to row 0. Live
  // frames are cached but not painted until the view is exited.
  let historyMode = false;
  const sessionViews: Record<string, SessionTerminalView> = {};
  const latestFrames: Record<string, TerminalFrame> = {};

  function mountRenderer(displayRows = surface.rows): TerminalRenderer | null {
    if (!els.canvas) return null;
    renderer = createRenderer(els.canvas, surface, displayRows);
    return renderer;
  }

  function ensureRenderer(
    forSurface: TerminalSurface,
    displayRows: number,
  ): TerminalRenderer | null {
    if (!renderer || renderer.cols !== forSurface.cols || renderer.rows !== displayRows) {
      needsFullPaint = true;
      lastStartRow = null;
      return mountRenderer(displayRows);
    }
    return renderer;
  }

  function updateSpacer(totalRows: number, forSurface: TerminalSurface) {
    const spacer = els.spacer;
    if (!spacer) return;
    const inset = terminalInsetPx(forSurface);
    const contentHeight = Math.max(totalRows, forSurface.rows) * forSurface.cellHeight;
    spacer.style.height = `${contentHeight + inset.top + inset.bottom}px`;
    spacer.style.width = `${forSurface.cols * forSurface.cellWidth}px`;
  }

  function paintWindow(
    frame: TerminalFrame | null = lastComposite,
    forSurface: TerminalSurface = surface,
  ) {
    if (!frame) return;
    const viewport = els.viewport;
    const viewportHeight = Math.max(
      forSurface.cellHeight,
      viewport?.clientHeight ?? forSurface.rows * forSurface.cellHeight,
    );
    const scrollTop = viewport?.scrollTop ?? 0;
    const inset = terminalInsetPx(forSurface);

    const { startRow, displayRows, forceFullPaint, windowFrame } = computePaintWindow({
      frame,
      surface: forSurface,
      scrollTop,
      viewportHeight,
      needsFullPaint,
      lastStartRow,
      topInsetPx: inset.top,
    });
    const activeRenderer = ensureRenderer(forSurface, displayRows);

    if (els.canvas) {
      // The canvas sits below the top inset (the injected blank scroll space), so
      // the first content row never butts against the top edge.
      els.canvas.style.transform = `translateY(${startRow * forSurface.cellHeight + inset.top}px)`;
    }
    if (forceFullPaint) {
      activeRenderer?.clear(themeColors.background);
    }
    activeRenderer?.paintFrame(windowFrame, buildOverlay(startRow, displayRows, forSurface));
    needsFullPaint = false;
    lastStartRow = startRow;
    emitScrollMetrics(forSurface);
  }

  // Compute + publish (deduped) the scroll position/extent for the overlay
  // scrollbar. History uses the DOM scroller (the spacer grows past the
  // viewport); live reads the backend's scrollback metadata, since live wheel
  // scrolling is backend-virtual and never moves the DOM.
  let lastScrollMetricsKey = '';
  function emitScrollMetrics(forSurface: TerminalSurface) {
    if (!onScrollMetrics) return;
    const cellHeight = forSurface.cellHeight;
    const viewport = els.viewport;
    let metrics: TerminalScrollMetrics;
    if (historyMode && viewport) {
      const total = viewport.scrollHeight;
      const view = viewport.clientHeight;
      const top = viewport.scrollTop;
      const scrollable = total > view + 1;
      metrics = {
        mode: 'history',
        scrollable,
        atBottom: top + view >= total - SCROLL_FOLLOW_EPSILON_PX,
        totalRows: Math.max(1, Math.round(total / cellHeight)),
        viewportRows: Math.max(1, Math.round(view / cellHeight)),
        offsetRows: Math.max(0, Math.round(top / cellHeight)),
        thumbFraction: scrollable ? Math.min(1, view / total) : 1,
        startFraction: total > 0 ? Math.min(1, top / total) : 0,
      };
    } else {
      const sb = lastComposite?.scrollback;
      const scrollbackRows = sb?.scrollbackRows ?? 0;
      const viewportRows = forSurface.rows;
      const totalRows = sb?.totalRows ?? scrollbackRows + viewportRows;
      const offsetRows = sb?.viewportOffset ?? scrollbackRows;
      const scrollable = scrollbackRows > 0 && totalRows > viewportRows;
      metrics = {
        mode: 'live',
        scrollable,
        atBottom: sb?.atBottom ?? true,
        totalRows,
        viewportRows,
        offsetRows,
        thumbFraction: totalRows > 0 ? Math.min(1, viewportRows / totalRows) : 1,
        startFraction: totalRows > 0 ? Math.min(1, offsetRows / totalRows) : 0,
      };
    }
    const key = `${metrics.mode}|${metrics.scrollable}|${metrics.atBottom}|${metrics.totalRows}|${metrics.viewportRows}|${metrics.offsetRows}`;
    if (key === lastScrollMetricsKey) return;
    lastScrollMetricsKey = key;
    onScrollMetrics(metrics);
  }

  // Translate the buffer-coordinate interaction state into the window-local
  // overlay the renderer draws. Returns undefined when there is nothing to draw
  // so the renderer can skip the overlay pass entirely.
  function buildOverlay(
    startRow: number,
    displayRows: number,
    forSurface: TerminalSurface,
  ): TerminalOverlay | undefined {
    const selectionSpans = selectionWindowSpans(selection, startRow, displayRows, forSurface.cols);
    const linkSpans: RowSpan[] = [];
    for (const link of links) {
      const span = rowSpanInWindow(
        link.row,
        link.startCol,
        link.endCol,
        startRow,
        displayRows,
        forSurface.cols,
      );
      if (span) linkSpans.push(span);
    }
    const hoverSpan = hoverLink
      ? rowSpanInWindow(
          hoverLink.row,
          hoverLink.startCol,
          hoverLink.endCol,
          startRow,
          displayRows,
          forSurface.cols,
        )
      : null;

    const searchSpans: RowSpan[] = [];
    for (const match of searchMatches) {
      const span = rowSpanInWindow(
        match.row,
        match.startCol,
        match.endCol,
        startRow,
        displayRows,
        forSurface.cols,
      );
      if (span) searchSpans.push(span);
    }
    const activeSpan = activeMatch
      ? rowSpanInWindow(
          activeMatch.row,
          activeMatch.startCol,
          activeMatch.endCol,
          startRow,
          displayRows,
          forSurface.cols,
        )
      : null;

    if (
      selectionSpans.length === 0 &&
      linkSpans.length === 0 &&
      !hoverSpan &&
      searchSpans.length === 0 &&
      !activeSpan
    ) {
      return undefined;
    }
    return {
      selection: selectionSpans.length > 0 ? selectionSpans : undefined,
      links: linkSpans.length > 0 ? linkSpans : undefined,
      hoverLink: hoverSpan ?? undefined,
      searchMatches: searchSpans.length > 0 ? searchSpans : undefined,
      activeMatch: activeSpan ?? undefined,
    };
  }

  // Repaint the current window with the overlay forced onto every visible row
  // (so a changed/cleared selection or hover never leaves stale pixels behind).
  function repaintOverlay() {
    needsFullPaint = true;
    paintWindow();
  }

  function shouldAutoFollow() {
    // An active selection (or find navigation) pins the viewport: output keeps
    // painting underneath, but we never auto-jump to the tail.
    return liveFollow && selection === null && !searchActive;
  }

  // Rescan the composite frame for URLs so hover/underline/click have up-to-date
  // spans. Cheap at viewport sizes (a regex per visible row). Called whenever the
  // composite changes.
  function recomputeLinks() {
    if (!lastComposite) {
      links = [];
      return;
    }
    const next: BufferLinkSpan[] = [];
    for (const row of lastComposite.rows) {
      const text = rowPlainText(row, surface.cols);
      for (const link of detectLinks(text)) {
        next.push({ row: row.index, startCol: link.start, endCol: link.end, href: link.href });
      }
    }
    links = next;
  }

  function linkAt(cell: BufferCell): BufferLinkSpan | null {
    for (const link of links) {
      if (link.row === cell.row && cell.col >= link.startCol && cell.col < link.endCol) return link;
    }
    return null;
  }

  function scrollToTail() {
    const viewport = els.viewport;
    if (!viewport) return;
    autoScrolling = true;
    viewport.scrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    paintWindow();
    requestAnimationFrame(() => {
      paintWindow();
      const stillFollowing =
        viewport.scrollTop + viewport.clientHeight >=
        viewport.scrollHeight - SCROLL_FOLLOW_EPSILON_PX;
      autoScrolling = false;
      setLiveFollow(stillFollowing);
    });
  }

  function applyView(view: SessionTerminalView, forSurface: TerminalSurface = surface) {
    lastFrame = view.lastFrame;
    lastComposite = view.compositeFrame;
    liveFollow = view.liveFollow;
    recomputeLinks();
    onScrollbackRowCount(view.rowCount);
    onLiveFollow(view.liveFollow);
    updateSpacer(view.compositeFrame.rows.length, forSurface);
    paintWindow(view.compositeFrame, forSurface);
    onComposite?.();
    requestAnimationFrame(() => {
      if (shouldAutoFollow()) scrollToTail();
      else paintWindow();
    });
  }

  function clearInteractionState() {
    selection = null;
    links = [];
    hoverLink = null;
    searchMatches = [];
    activeMatch = null;
  }

  function clear(forSurface: TerminalSurface = surface) {
    renderer = null;
    needsFullPaint = true;
    lastStartRow = null;
    clearInteractionState();
    const view = emptyTerminalView(forSurface);
    lastFrame = null;
    lastComposite = view.compositeFrame;
    setLiveFollow(true);
    onScrollbackRowCount(0);
    updateSpacer(forSurface.rows, forSurface);
    paintWindow(view.compositeFrame, forSurface);
  }

  function resetScrollback() {
    lastComposite = null;
    needsFullPaint = true;
    lastStartRow = null;
    clearInteractionState();
    setLiveFollow(true);
    onScrollbackRowCount(0);
    updateSpacer(surface.rows, surface);
  }

  function paintFrame(rawFrame: TerminalFrame) {
    const surfaceFrame = frameForSurface(rawFrame, surface);
    lastFrame = surfaceFrame;
    onScrollbackRowCount(surfaceFrame.scrollback?.scrollbackRows ?? 0);
    lastComposite = surfaceFrame;
    recomputeLinks();
    updateSpacer(surfaceFrame.rows.length, surface);
    paintWindow(surfaceFrame, surface);
    onComposite?.();
    requestAnimationFrame(() => {
      if (shouldAutoFollow()) scrollToTail();
      else paintWindow();
    });
  }

  function ensureSessionView(
    sessionId: string,
    forSurface: TerminalSurface = surface,
  ): SessionTerminalView | undefined {
    const frame = latestFrames[sessionId];
    if (frame) {
      const view = buildSessionTerminalView(sessionViews[sessionId], frame, forSurface);
      sessionViews[sessionId] = view;
      return view;
    }
    return sessionViews[sessionId];
  }

  function paintCurrent(selectedSessionId: string | null, forSurface: TerminalSurface = surface) {
    if (selectedSessionId) {
      const view = ensureSessionView(selectedSessionId, forSurface);
      if (view) {
        applyView(view, forSurface);
        return;
      }
    }
    if (lastFrame) {
      paintFrame(lastFrame);
      return;
    }
    clear(forSurface);
  }

  // Per-frame ingestion from the backend stream. Active sessions build + apply a
  // fresh view; backgrounded sessions keep only the raw frame and drop any stale
  // built view, so off-screen output costs nothing on the main thread.
  function ingestFrame(sessionId: string, frame: TerminalFrame, isActive: boolean) {
    latestFrames[sessionId] = frame;
    // In history view we keep showing the replayed transcript; live frames are
    // cached (so exiting resumes correctly) but do not repaint.
    if (isActive && !historyMode) {
      const next = buildSessionTerminalView(sessionViews[sessionId], frame, surface);
      sessionViews[sessionId] = next;
      applyView(next);
    } else if (!isActive) {
      delete sessionViews[sessionId];
    }
  }

  // Enter the full-history view: paint the replayed transcript frame (all rows)
  // and size the spacer to it, so the frontend scrollbar scrolls the whole
  // session. Lands at the bottom (most recent), continuous with the live tail;
  // the user scrolls up toward row 0.
  function enterHistory(frame: TerminalFrame, scrollToBottom = true) {
    historyMode = true;
    clearInteractionState();
    lastComposite = frame;
    needsFullPaint = true;
    lastStartRow = null;
    setLiveFollow(false);
    onScrollbackRowCount(Math.max(0, frame.rows.length - surface.rows));
    updateSpacer(frame.rows.length, surface);
    if (scrollToBottom) {
      // "Full history": land at the most recent rows, continuous with the live
      // tail; the user scrolls up toward row 0. Deferred so the grown spacer's
      // scrollHeight is laid out before we read it.
      requestAnimationFrame(() => {
        const viewport = els.viewport;
        if (viewport)
          viewport.scrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
        paintWindow(frame, surface);
      });
    } else {
      // Find drives the scroll itself (to the active match), so paint in place
      // now and skip the scroll-to-bottom that would otherwise override it.
      paintWindow(frame, surface);
    }
  }

  function exitHistory() {
    historyMode = false;
    clearInteractionState();
  }

  // Scroll the (frontend-virtualized) full-history viewport so composite `row`
  // is visible, aimed about a third down from the top for context, then repaint
  // that window. Find navigation uses this to land on a match anywhere in the
  // session, including rows far above the live band.
  function scrollToHistoryRow(row: number) {
    const viewport = els.viewport;
    if (!viewport) return;
    const target = (row - Math.floor(surface.rows / 3)) * surface.cellHeight;
    const max = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    viewport.scrollTop = Math.max(0, Math.min(target, max));
    needsFullPaint = true;
    paintWindow();
  }

  function setLiveFollow(live: boolean) {
    liveFollow = live;
    onLiveFollow(live);
  }

  return {
    attach(next: TerminalDomRefs) {
      els = next;
    },
    setSurface(next: TerminalSurface) {
      surface = next;
    },
    getSurface() {
      return surface;
    },
    resetRenderer() {
      renderer = null;
    },
    // Apply the active shell theme's terminal colors. Recreates the renderer so
    // its default fg/bg pick up the new theme, then forces a full repaint of the
    // current composite. The live backend terminal is updated separately (the
    // hook calls set_terminal_theme), which also re-emits a themed frame.
    setThemeColors(colors: TerminalThemeColors) {
      themeColors = colors;
      if (els.canvas && renderer) {
        mountRenderer(renderer.rows);
        needsFullPaint = true;
        paintWindow();
      }
    },
    requireRenderer(): TerminalRenderer {
      const active = renderer ?? mountRenderer();
      if (!active) throw new Error('Terminal renderer is not mounted yet');
      return active;
    },
    seedEmptyView(sessionId: string) {
      const view = emptyTerminalView(surface);
      sessionViews[sessionId] = view;
      return view;
    },
    paintWindow,
    applyView,
    paintFrame,
    paintCurrent,
    clear,
    resetScrollback,
    scrollToTail,
    ensureSessionView,
    ingestFrame,
    dropSession(sessionId: string) {
      delete sessionViews[sessionId];
      delete latestFrames[sessionId];
    },
    focusCanvas() {
      els.canvas?.focus();
    },
    getLastFrameModes(): TerminalModes | undefined {
      return lastFrame?.modes;
    },
    isLiveFollow() {
      return liveFollow;
    },
    setLiveFollow,
    isAutoScrolling() {
      return autoScrolling;
    },

    // --- Interaction layer surface (read state + drive the overlay) ---
    // The painted window origin (buffer row of the top painted row); hit-testing
    // adds the window-local row to this to land in composite coordinates.
    getStartRow(): number {
      return lastStartRow ?? 0;
    },
    getComposite(): TerminalFrame | null {
      return lastComposite;
    },
    getViewport(): HTMLDivElement | null {
      return els.viewport;
    },
    getCanvas(): HTMLCanvasElement | null {
      return els.canvas;
    },
    getSelection(): SelectionRange | null {
      return selection;
    },
    hasSelection(): boolean {
      return selection !== null;
    },
    setSelection(range: SelectionRange | null) {
      selection = range;
      repaintOverlay();
    },
    clearSelection() {
      if (selection === null) return;
      selection = null;
      repaintOverlay();
      // No explicit scroll here: shouldAutoFollow() becomes true again, so the
      // next streamed frame resumes tail-follow on its own. Clearing a selection
      // never yanks the viewport.
    },
    // Drop the selection + hover when the displayed session changes, so a stale
    // selection (in the previous session's coordinates) never pins the new
    // session's viewport or leaks into its copied text. Links are frame-derived
    // and rebuilt by recomputeLinks on the next applied view, so they are left
    // alone here.
    resetInteraction() {
      if (
        selection === null &&
        hoverLink === null &&
        searchMatches.length === 0 &&
        activeMatch === null
      ) {
        return;
      }
      selection = null;
      hoverLink = null;
      searchMatches = [];
      activeMatch = null;
      repaintOverlay();
    },
    getSelectionText(): string {
      if (!selection || !lastComposite) return '';
      return selectionText(lastComposite, selection, surface.cols);
    },
    setLinks(next: BufferLinkSpan[]) {
      links = next;
      repaintOverlay();
    },
    getLinks(): BufferLinkSpan[] {
      return links;
    },
    linkAt,
    setHoverLink(next: BufferLinkSpan | null) {
      const sameRow =
        hoverLink &&
        next &&
        hoverLink.row === next.row &&
        hoverLink.startCol === next.startCol &&
        hoverLink.endCol === next.endCol;
      if (sameRow || (!hoverLink && !next)) return;
      hoverLink = next;
      repaintOverlay();
    },
    // Find-in-terminal overlay: match spans (buffer coords) + the active match.
    setSearchMatches(next: RowSpan[]) {
      searchMatches = next;
      repaintOverlay();
    },
    setActiveMatch(next: RowSpan | null) {
      activeMatch = next;
      repaintOverlay();
    },
    clearSearch() {
      if (searchMatches.length === 0 && activeMatch === null) return;
      searchMatches = [];
      activeMatch = null;
      repaintOverlay();
    },
    setSearchActive(active: boolean) {
      searchActive = active;
    },
    enterHistory,
    exitHistory,
    scrollToHistoryRow,
    isHistoryMode() {
      return historyMode;
    },
  };
}

export type TerminalController = ReturnType<typeof createTerminalController>;
