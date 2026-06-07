import { useEffect, useRef } from 'react';

import { css } from '../../styled-system/css';
import { createResumeBloom, type ResumeBloomHandle } from '../../resumeBloom';
import { useUiStore } from '../../store';

// React wrapper around the imperative resume-bloom canvas island. Mounts and
// destroys the bloom, and refreshes its dot color when the theme changes (the
// terminal surface follows the theme, so the bloom must track `--text` too).
// Like DotField, the only owner of the canvas is the imperative island; callers
// just drop this in behind the "Resuming" copy.
export function ResumeBloom() {
  const theme = useUiStore(s => s.theme);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const handleRef = useRef<ResumeBloomHandle | null>(null);

  useEffect(() => {
    if (!canvasRef.current) return;
    handleRef.current = createResumeBloom(canvasRef.current);
    return () => {
      handleRef.current?.destroy();
      handleRef.current = null;
    };
  }, []);

  useEffect(() => {
    handleRef.current?.refresh();
  }, [theme]);

  return <canvas ref={canvasRef} className={bloomCanvasClass} aria-hidden="true" />;
}

const bloomCanvasClass = css({
  position: 'absolute',
  inset: 0,
  width: '100%',
  height: '100%',
  pointerEvents: 'none',
  zIndex: 0,
  display: 'block',
});
