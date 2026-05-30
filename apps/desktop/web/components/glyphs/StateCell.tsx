import { useEffect, useRef } from 'react';

import { registerStateCell, type CellState, type StateCellHandle } from '../../stateField';

// The live session-state glyph: a dot constellation drawn by the shared WebGL
// renderer (stateField.ts), whose motion encodes the state. Each instance owns a
// small 2D <canvas> that the renderer stamps into; the canvas is clipped and
// scrolled by its container for free. Replaces the CSS-pulsed SessionStatusGlyph
// on cards, sidebar rows, and tabs.
export function StateCell({
  state,
  size = 22,
  className,
}: {
  state: CellState;
  size?: number;
  className?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const handleRef = useRef<StateCellHandle | null>(null);
  // A stable per-instance seed so each cell's drift/phase differs (set once).
  const seedRef = useRef(0);
  if (seedRef.current === 0) seedRef.current = 1 + Math.random() * 9;

  useEffect(() => {
    if (!canvasRef.current) return;
    handleRef.current = registerStateCell(canvasRef.current, state, seedRef.current);
    return () => {
      handleRef.current?.destroy();
      handleRef.current = null;
    };
    // Register once on mount; the next effect forwards state changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    handleRef.current?.update(state);
  }, [state]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      data-state={state}
      className={className}
      style={{ width: size, height: size, display: 'block', flexShrink: 0 }}
    />
  );
}
