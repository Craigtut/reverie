import { describe, expect, it } from 'vitest';
import {
  FULLSCREEN_APP_BOTTOM_INSET_PX,
  TERMINAL_BOTTOM_INSET_PX,
  TERMINAL_TOP_INSET_PX,
  type TerminalSurface,
  terminalInsetPx,
  terminalSurfaceForBounds,
} from '../terminalScrollback';

const base: TerminalSurface = {
  cols: 80,
  rows: 24,
  cellWidth: 10,
  cellHeight: 20,
  fontSize: 14,
  baseline: 15,
  fontFamily: 'monospace',
};

describe('fullscreen app fit', () => {
  it('trades the inline bottom scroll padding for rows', () => {
    const height = 1_000;
    const inline = terminalSurfaceForBounds(1_000, height, base);
    const fullscreen = terminalSurfaceForBounds(1_000, height, { ...base, fullscreenApp: true });

    expect(inline.rows).toBe(
      Math.floor((height - TERMINAL_TOP_INSET_PX - TERMINAL_BOTTOM_INSET_PX) / base.cellHeight),
    );
    expect(fullscreen.rows).toBe(
      Math.floor(
        (height - TERMINAL_TOP_INSET_PX - FULLSCREEN_APP_BOTTOM_INSET_PX) / base.cellHeight,
      ),
    );
    expect(fullscreen.rows).toBeGreaterThan(inline.rows);
    expect(fullscreen.cols).toBe(inline.cols);
    expect(fullscreen.fullscreenApp).toBe(true);
  });

  it('keeps the top inset for the floating tabs in both modes', () => {
    expect(terminalInsetPx(base).top).toBe(TERMINAL_TOP_INSET_PX);
    expect(terminalInsetPx({ ...base, fullscreenApp: true }).top).toBe(TERMINAL_TOP_INSET_PX);
    expect(terminalInsetPx({ ...base, fullscreenApp: true }).bottom).toBe(
      FULLSCREEN_APP_BOTTOM_INSET_PX,
    );
  });
});
