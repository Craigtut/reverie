import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { css } from '../../styled-system/css';
import type { TerminalScrollMetrics } from '../../terminalScrollback';

export interface TerminalScrollbarModel {
  metrics: TerminalScrollMetrics | null;
  scrollToFraction: (startFraction: number) => void;
}

// A draggable thumb never shrinks below this fraction of the track, so deep
// histories keep a grabbable handle.
const MIN_THUMB_FRACTION = 0.08;

// How long the thumb lingers after the last scroll movement before it fades out
// again (it also stays while hovered or dragging). Mirrors the calm auto-hide of
// the native scrollbars used elsewhere; the terminal needs a custom bar because
// its scrolling is virtual, not a real DOM overflow.
const IDLE_FADE_MS = 1400;

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
  // Recently moved: the thumb is hidden at rest and reveals when the user scrolls
  // (offset changes) or hovers, then fades back out after IDLE_FADE_MS.
  const [active, setActive] = useState(false);

  const scrollable = Boolean(metrics?.scrollable);
  const totalRows = metrics?.totalRows ?? 1;
  const viewportRows = metrics?.viewportRows ?? 1;
  const thumbFraction = Math.min(1, Math.max(MIN_THUMB_FRACTION, metrics?.thumbFraction ?? 1));
  // Travel = the track range the thumb top can occupy (0..1-thumbFraction).
  const travel = Math.max(0, 1 - thumbFraction);
  const scrollRows = Math.max(1, totalRows - viewportRows);
  const offsetRows = metrics?.offsetRows ?? 0;
  const positionFraction = Math.min(1, Math.max(0, offsetRows / scrollRows));
  const topFraction = positionFraction * travel;

  // Reveal on scroll movement, then fade after the idle delay. Keyed on the
  // scroll offset so it fires when the user actually moves through history, not
  // while output merely streams at the tail (offset stays 0 there).
  const mountedRef = useRef(false);
  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      return; // no reveal flash on first mount
    }
    setActive(true);
    const id = window.setTimeout(() => setActive(false), IDLE_FADE_MS);
    return () => window.clearTimeout(id);
  }, [offsetRows]);

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
      data-active={active ? 'true' : 'false'}
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

// The scrollbar gutter: a slim fixed-width column beside the terminal panel (not
// an overlay), so the thumb never sits on top of the content. The gutter is
// always reserved (the panel never reflows when scrollback appears), but the
// thumb auto-hides: invisible at rest, revealed while the user scrolls (data-
// active), hovers, or drags, then fades back out. Calm + monochrome.
const trackClass = css({
  position: 'relative',
  flexShrink: 0,
  alignSelf: 'stretch',
  width: '10px',
  cursor: 'default',
  touchAction: 'none',
  // Hidden at rest; revealed by recent scrolling, then hover, then dragging
  // (later rules win at equal specificity, so each state brightens the last).
  '& [data-thumb]': { opacity: 0 },
  '&[data-active="true"] [data-thumb]': { opacity: 0.5 },
  _hover: { '& [data-thumb]': { opacity: 0.7 } },
  '&[data-dragging="true"] [data-thumb]': { opacity: 0.9 },
});

const thumbClass = css({
  position: 'absolute',
  left: '2.5px',
  width: '5px',
  minHeight: '24px',
  borderRadius: '999px',
  background: 'var(--text-2)',
  pointerEvents: 'none',
  transition: 'opacity 160ms ease, background 140ms ease',
});
