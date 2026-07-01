import type { TerminalSurface } from '../../terminalScrollback';
import { applyCrtWarp, clamp } from './geometry';

export interface TerminalMouseCell {
  row: number;
  col: number;
}

export interface TerminalMouseModifiers {
  shift?: boolean;
  alt?: boolean;
  ctrl?: boolean;
}

export type TerminalMouseButton = 0 | 1 | 2;
export type TerminalMouseAction = 'press' | 'release' | 'motion';
export type TerminalWheelDirection = 'up' | 'down';

export function terminalMouseCellFromClientPoint(
  clientX: number,
  clientY: number,
  canvas: HTMLCanvasElement,
  surface: TerminalSurface,
  crtCurvature = 0,
): TerminalMouseCell | null {
  if (surface.cols <= 0 || surface.rows <= 0) return null;
  const rect = canvas.getBoundingClientRect();
  const width = surface.cols * surface.cellWidth;
  const height = surface.rows * surface.cellHeight;
  // Unwarp the pointer through the CRT lens before the bounds check + cell
  // division so a click lands on the cell the user visually sees.
  const { x: localX, y: localY } = applyCrtWarp(
    clientX - rect.left,
    clientY - rect.top,
    width,
    height,
    crtCurvature,
  );
  if (localX < 0 || localY < 0 || localX >= width || localY >= height) return null;
  return {
    row: clamp(Math.floor(localY / surface.cellHeight), 0, surface.rows - 1),
    col: clamp(Math.floor(localX / surface.cellWidth), 0, surface.cols - 1),
  };
}

export function terminalMouseButtonFromDom(button: number): TerminalMouseButton | null {
  if (button === 0 || button === 1 || button === 2) return button;
  return null;
}

export function encodeSgrMouseEvent(options: {
  cell: TerminalMouseCell;
  button: TerminalMouseButton;
  action: TerminalMouseAction;
  modifiers?: TerminalMouseModifiers;
}): string {
  const motionOffset = options.action === 'motion' ? 32 : 0;
  const buttonCode = options.button + motionOffset + modifierBits(options.modifiers);
  const suffix = options.action === 'release' ? 'm' : 'M';
  return sgrMouseSequence(buttonCode, options.cell, suffix);
}

export function encodeSgrWheelEvent(options: {
  cell: TerminalMouseCell;
  direction: TerminalWheelDirection;
  modifiers?: TerminalMouseModifiers;
}): string {
  const buttonCode = (options.direction === 'up' ? 64 : 65) + modifierBits(options.modifiers);
  return sgrMouseSequence(buttonCode, options.cell, 'M');
}

function modifierBits(modifiers: TerminalMouseModifiers | undefined): number {
  let bits = 0;
  if (modifiers?.shift) bits += 4;
  if (modifiers?.alt) bits += 8;
  if (modifiers?.ctrl) bits += 16;
  return bits;
}

function sgrMouseSequence(buttonCode: number, cell: TerminalMouseCell, suffix: 'M' | 'm'): string {
  return `\x1b[<${buttonCode};${cell.col + 1};${cell.row + 1}${suffix}`;
}
