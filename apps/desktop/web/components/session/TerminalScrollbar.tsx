import { useRef, useState, type PointerEvent } from 'react';
import { css } from '../../styled-system/css';
import type { TerminalScrollMetrics } from '../../terminalScrollback';

export interface TerminalScrollbarModel {
  metrics: TerminalScrollMetrics | null;
  scrollToFraction: (startFraction: number) => void;
}

// A draggable thumb never shrinks below this fraction of the track, so deep
// histories keep a grabbable handle.
const MIN_THUMB_FRACTION = 0.08;

// The custom scrollbar. Reflects scroll position in both the live view (driven by
// the backend's scrollback metadata, since live scrolling never moves the DOM)
// and the full-history view (driven by the DOM scroller). Rendered in a gutter
// beside the terminal panel; click or drag to move. The gutter is always present
// (so the panel never reflows when scrollback appears) and the thumb shows only
// when there is something to scroll. Calm + monochrome: subtle, brighter on
// hover/drag.
export function TerminalScrollbar({ model }: { model: TerminalScrollbarModel }) {
  const { metrics, scrollToFraction } = model;
  const trackRef = useRef<HTMLDivElement | null>(null);
  const grabRef = useRef(0);
  const [dragging, setDragging] = useState(false);

  const scrollable = Boolean(metrics?.scrollable);
  const totalRows = metrics?.totalRows ?? 1;
  const viewportRows = metrics?.viewportRows ?? 1;
  const thumbFraction = Math.min(1, Math.max(MIN_THUMB_FRACTION, metrics?.thumbFraction ?? 1));
  // Travel = the track range the thumb top can occupy (0..1-thumbFraction).
  const travel = Math.max(0, 1 - thumbFraction);
  const scrollRows = Math.max(1, totalRows - viewportRows);
  const positionFraction = Math.min(1, Math.max(0, (metrics?.offsetRows ?? 0) / scrollRows));
  const topFraction = positionFraction * travel;

  // Convert a pointer Y (within the track) to the startFraction (offset/total)
  // that `scrollToFraction` expects.
  function startFractionFromPointer(clientY: number): number {
    const track = trackRef.current;
    if (!track) return 0;
    const rect = track.getBoundingClientRect();
    const rel = (clientY - rect.top) / Math.max(1, rect.height);
    const desiredTop = Math.min(travel, Math.max(0, rel - grabRef.current));
    const position = travel > 0 ? desiredTop / travel : 0;
    return (position * scrollRows) / Math.max(1, totalRows);
  }

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (!scrollable) return;
    const track = trackRef.current;
    if (!track) return;
    const rect = track.getBoundingClientRect();
    const rel = (event.clientY - rect.top) / Math.max(1, rect.height);
    const onThumb = rel >= topFraction && rel <= topFraction + thumbFraction;
    // Grab offset keeps the cursor's position within the thumb fixed while
    // dragging; a track press recenters the thumb on the cursor.
    grabRef.current = onThumb ? rel - topFraction : thumbFraction / 2;
    track.setPointerCapture(event.pointerId);
    setDragging(true);
    scrollToFraction(startFractionFromPointer(event.clientY));
    event.preventDefault();
    event.stopPropagation();
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    if (!dragging) return;
    scrollToFraction(startFractionFromPointer(event.clientY));
  }

  function onPointerUp(event: PointerEvent<HTMLDivElement>) {
    if (!dragging) return;
    trackRef.current?.releasePointerCapture(event.pointerId);
    setDragging(false);
  }

  return (
    <div
      ref={trackRef}
      className={trackClass}
      data-testid="terminal-scrollbar"
      data-scrollable={scrollable ? 'true' : 'false'}
      data-dragging={dragging ? 'true' : 'false'}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      {scrollable ? (
        <div
          className={thumbClass}
          data-thumb
          data-testid="terminal-scrollbar-thumb"
          style={{ top: `${topFraction * 100}%`, height: `${thumbFraction * 100}%` }}
        />
      ) : null}
    </div>
  );
}

// The scrollbar gutter: a fixed-width column beside the terminal panel (not an
// overlay), so the thumb never sits on top of the content.
const trackClass = css({
  position: 'relative',
  flexShrink: 0,
  alignSelf: 'stretch',
  width: '12px',
  cursor: 'default',
  touchAction: 'none',
  // The thumb is subtle by default and brightens on hover / while dragging.
  '& [data-thumb]': { opacity: 0.42 },
  _hover: { '& [data-thumb]': { opacity: 0.7 } },
  '&[data-dragging="true"] [data-thumb]': { opacity: 0.9 },
});

const thumbClass = css({
  position: 'absolute',
  left: '3px',
  width: '6px',
  minHeight: '24px',
  borderRadius: '999px',
  background: 'var(--text-2)',
  pointerEvents: 'none',
  transition: 'opacity 140ms ease, background 140ms ease',
});
