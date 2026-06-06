import { useCallback, useEffect, useRef, useState, type PointerEvent, type RefObject } from 'react';
import { css } from '../../styled-system/css';

// An auto-hiding overlay scrollbar for native DOM overflow regions. It mirrors the
// terminal's custom scrollbar (TerminalScrollbar.tsx): hidden at rest, revealed
// while the user scrolls (offset changes), hovers the gutter, or drags the thumb,
// then fades back out after a short idle delay.
//
// Why a custom bar instead of the real one: a styled `::-webkit-scrollbar` can't
// fade (WebKit won't animate the scrollbar pseudo-elements), and the native macOS
// overlay bar can't be recolored away from the heavy "always show scroll bars"
// legacy track. Driving opacity on a real DOM thumb is the only way to get the
// terminal's calm fade consistently. The host scroller keeps its native overflow
// for wheel/trackpad/keyboard scrolling; this only reflects position and adds
// click/drag.
//
// Mount it as a flex sibling of the scroll element inside a relative, row-flex
// viewport, and hide the scroller's native bar. The bar then lives in its own
// reserved gutter column (it never overlaps content or blocks clicks, and the
// panel never reflows when scrollback appears). Pass a ref to the scroll element.

const IDLE_FADE_MS = 1400; // matches TerminalScrollbar's auto-hide delay
const MIN_THUMB_PX = 24; // keep a grabbable handle even in very long lists

interface ThumbGeom {
  scrollable: boolean;
  top: number;
  height: number;
}

export function OverlayScrollbar({ scrollRef }: { scrollRef: RefObject<HTMLElement | null> }) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const grabRef = useRef(0);
  const fadeTimer = useRef(0);
  const [dragging, setDragging] = useState(false);
  // Recently moved: the thumb is hidden at rest and reveals on scroll, then fades
  // back out after IDLE_FADE_MS (it also stays while hovered or dragging via CSS).
  const [active, setActive] = useState(false);
  const [geom, setGeom] = useState<ThumbGeom>({ scrollable: false, top: 0, height: 0 });

  // Recompute thumb size/position from the live scroll element. The track height
  // equals the scroller's viewport, so the thumb maps 1:1 to the visible fraction.
  const measure = useCallback(() => {
    const el = scrollRef.current;
    const track = trackRef.current;
    if (!el || !track) return;
    const trackH = track.clientHeight;
    const { scrollTop, scrollHeight, clientHeight } = el;
    const scrollable = scrollHeight > clientHeight + 1 && trackH > 0;
    if (!scrollable) {
      setGeom(g => (g.scrollable ? { scrollable: false, top: 0, height: 0 } : g));
      return;
    }
    const height = Math.max(MIN_THUMB_PX, (clientHeight / scrollHeight) * trackH);
    const maxTop = Math.max(0, trackH - height);
    const top = (scrollTop / (scrollHeight - clientHeight)) * maxTop;
    setGeom({ scrollable: true, top, height });
  }, [scrollRef]);

  const reveal = useCallback(() => {
    setActive(true);
    window.clearTimeout(fadeTimer.current);
    fadeTimer.current = window.setTimeout(() => setActive(false), IDLE_FADE_MS);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    measure();
    const onScroll = () => {
      measure();
      reveal();
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    // Viewport resize (window/layout) and content height changes (topics
    // expanding/collapsing, rows added) both move the thumb geometry.
    const ro = new ResizeObserver(() => measure());
    ro.observe(el);
    const content = el.firstElementChild;
    if (content) ro.observe(content);
    const mo = new MutationObserver(() => measure());
    mo.observe(el, { childList: true, subtree: true });
    return () => {
      el.removeEventListener('scroll', onScroll);
      ro.disconnect();
      mo.disconnect();
      window.clearTimeout(fadeTimer.current);
    };
  }, [scrollRef, measure, reveal]);

  // Convert a pointer Y within the track into a scrollTop, keeping the grabbed
  // point on the thumb fixed while dragging (a track press recenters on the cursor).
  const scrollToPointer = useCallback(
    (clientY: number) => {
      const el = scrollRef.current;
      const track = trackRef.current;
      if (!el || !track) return;
      const rect = track.getBoundingClientRect();
      const trackH = rect.height;
      const height = Math.max(MIN_THUMB_PX, (el.clientHeight / el.scrollHeight) * trackH);
      const maxTop = Math.max(0, trackH - height);
      const desiredTop = Math.min(maxTop, Math.max(0, clientY - rect.top - grabRef.current));
      const fraction = maxTop > 0 ? desiredTop / maxTop : 0;
      el.scrollTop = fraction * (el.scrollHeight - el.clientHeight);
    },
    [scrollRef],
  );

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    const track = trackRef.current;
    if (!track || !geom.scrollable) return;
    const rect = track.getBoundingClientRect();
    const y = event.clientY - rect.top;
    const onThumb = y >= geom.top && y <= geom.top + geom.height;
    grabRef.current = onThumb ? y - geom.top : geom.height / 2;
    track.setPointerCapture(event.pointerId);
    setDragging(true);
    reveal();
    scrollToPointer(event.clientY);
    event.preventDefault();
    event.stopPropagation();
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    if (!dragging) return;
    scrollToPointer(event.clientY);
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
      data-testid="overlay-scrollbar"
      data-scrollable={geom.scrollable ? 'true' : 'false'}
      data-active={active ? 'true' : 'false'}
      data-dragging={dragging ? 'true' : 'false'}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      {geom.scrollable ? (
        <div
          className={thumbClass}
          data-thumb
          data-testid="overlay-scrollbar-thumb"
          style={{ transform: `translateY(${geom.top}px)`, height: `${geom.height}px` }}
        />
      ) : null}
    </div>
  );
}

// The gutter: a slim fixed-width column beside the scroller. Always reserved (so
// the panel never reflows when content overflows), but the thumb auto-hides:
// invisible at rest, revealed by recent scrolling (data-active), hover, then
// dragging. Mirrors TerminalScrollbar so the two bars match exactly.
const trackClass = css({
  position: 'relative',
  flexShrink: 0,
  alignSelf: 'stretch',
  width: '10px',
  cursor: 'default',
  touchAction: 'none',
  // Hidden at rest; revealed by recent scrolling, then hover, then dragging (later
  // rules win at equal specificity, so each state brightens the last).
  '& [data-thumb]': { opacity: 0 },
  '&[data-active="true"] [data-thumb]': { opacity: 0.5 },
  _hover: { '& [data-thumb]': { opacity: 0.7 } },
  '&[data-dragging="true"] [data-thumb]': { opacity: 0.9 },
});

const thumbClass = css({
  position: 'absolute',
  top: 0,
  left: '2.5px',
  width: '5px',
  minHeight: '24px',
  borderRadius: '999px',
  background: 'var(--text-2)',
  pointerEvents: 'none',
  // Only opacity/background fade; position is driven instantly via transform so
  // dragging never lags.
  transition: 'opacity 160ms ease, background 140ms ease',
});
