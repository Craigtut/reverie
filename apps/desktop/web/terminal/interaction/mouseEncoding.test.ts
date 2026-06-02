import { describe, expect, it } from 'vitest';
import type { TerminalSurface } from '../../terminalScrollback';
import {
  encodeSgrMouseEvent,
  encodeSgrWheelEvent,
  terminalMouseButtonFromDom,
  terminalMouseCellFromClientPoint,
} from './mouseEncoding';

const cell = { row: 3, col: 2 };

describe('encodeSgrMouseEvent', () => {
  it('encodes press, release, and drag motion in SGR 1006 coordinates', () => {
    expect(encodeSgrMouseEvent({ cell, button: 0, action: 'press' })).toBe('\x1b[<0;3;4M');
    expect(encodeSgrMouseEvent({ cell, button: 0, action: 'release' })).toBe('\x1b[<0;3;4m');
    expect(encodeSgrMouseEvent({ cell, button: 2, action: 'motion' })).toBe('\x1b[<34;3;4M');
  });

  it('adds terminal mouse modifier bits', () => {
    expect(
      encodeSgrMouseEvent({
        cell,
        button: 1,
        action: 'press',
        modifiers: { shift: true, alt: true, ctrl: true },
      }),
    ).toBe('\x1b[<29;3;4M');
  });
});

describe('encodeSgrWheelEvent', () => {
  it('encodes vertical wheel directions', () => {
    expect(encodeSgrWheelEvent({ cell, direction: 'up' })).toBe('\x1b[<64;3;4M');
    expect(encodeSgrWheelEvent({ cell, direction: 'down' })).toBe('\x1b[<65;3;4M');
  });
});

describe('terminal mouse hit-testing', () => {
  const surface: TerminalSurface = {
    cols: 10,
    rows: 5,
    cellWidth: 8,
    cellHeight: 16,
    fontSize: 14,
    baseline: 12,
    fontFamily: 'monospace',
  };
  const canvas = {
    getBoundingClientRect: () => ({
      x: 100,
      y: 50,
      left: 100,
      top: 50,
      right: 180,
      bottom: 130,
      width: 80,
      height: 80,
      toJSON: () => ({}),
    }),
  } as HTMLCanvasElement;

  it('maps client coordinates to viewport-local terminal cells', () => {
    expect(terminalMouseCellFromClientPoint(117, 83, canvas, surface)).toEqual({ row: 2, col: 2 });
  });

  it('returns null outside the live terminal grid', () => {
    expect(terminalMouseCellFromClientPoint(99, 83, canvas, surface)).toBeNull();
    expect(terminalMouseCellFromClientPoint(180, 83, canvas, surface)).toBeNull();
  });
});

describe('terminalMouseButtonFromDom', () => {
  it('accepts primary, middle, and secondary buttons only', () => {
    expect(terminalMouseButtonFromDom(0)).toBe(0);
    expect(terminalMouseButtonFromDom(1)).toBe(1);
    expect(terminalMouseButtonFromDom(2)).toBe(2);
    expect(terminalMouseButtonFromDom(3)).toBeNull();
  });
});
