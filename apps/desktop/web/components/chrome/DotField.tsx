import { useEffect, useRef } from 'react';

import { css } from '../../styled-system/css';
import { createDotField, type DotFieldHandle, type DotFieldVariant } from '../../dotField';
import { useUiStore } from '../../store';

// React wrapper around the imperative dot-field canvas island: mounts and
// destroys the field per variant, and refreshes it when the theme changes.
// Reads the active theme straight from the UI store, so callers only choose a
// variant.
export function DotField({ variant = 'ambient' }: { variant?: DotFieldVariant }) {
  const theme = useUiStore(s => s.theme);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const handleRef = useRef<DotFieldHandle | null>(null);

  useEffect(() => {
    if (!canvasRef.current) return;
    handleRef.current = createDotField(canvasRef.current, { variant });
    return () => {
      handleRef.current?.destroy();
      handleRef.current = null;
    };
  }, [variant]);

  useEffect(() => {
    handleRef.current?.refresh();
  }, [theme]);

  return <canvas ref={canvasRef} className={dotFieldCanvasClass} aria-hidden="true" />;
}

const dotFieldCanvasClass = css({
  position: 'absolute',
  inset: 0,
  width: '100%',
  height: '100%',
  pointerEvents: 'none',
  zIndex: 0,
  display: 'block',
});
