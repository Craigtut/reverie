import { useCallback, useRef } from 'react';

// How long the scrollbar stays visible after the cursor leaves the container (or
// after the last scroll, for keyboard users who never hovered) before it fades.
const HOLD_MS = 4000;

// Drives the hover/scroll-triggered scrollbar reveal for a container styled with
// scrollFadeClass. The scrollbar fades in while the cursor is inside and holds
// visible; once the cursor leaves it stays for 4s, then fades out. Active
// scrolling (wheel, trackpad, keyboard) also reveals it and resets the 4s timer,
// so keyboard users get the same feedback without hovering.
//
// This hook owns only the visible/idle state machine, exposed by toggling a
// `data-scrollbar` attribute on the element. The ~200ms fade and the
// reduced-motion fallback (instant show/hide, same timing) live in CSS
// (scrollFadeClass). Attach the returned callback ref to the scrollable element
// and give it scrollFadeClass.
//
// A callback ref (not a RefObject) is used on purpose: several scroll containers
// mount conditionally, so listeners must attach when the node actually appears
// and detach when it goes away, not once on the consumer's first render.
export function useScrollbarFade<T extends HTMLElement = HTMLDivElement>() {
  const cleanupRef = useRef<(() => void) | null>(null);

  return useCallback((el: T | null) => {
    // Detach from a previous node (ref reassignment or unmount).
    if (cleanupRef.current) {
      cleanupRef.current();
      cleanupRef.current = null;
    }
    if (!el) return;

    let hovered = false;
    let hideTimer = 0;

    const show = () => {
      el.dataset.scrollbar = 'visible';
    };
    const hide = () => {
      el.dataset.scrollbar = 'idle';
    };
    const cancelHide = () => {
      if (hideTimer) {
        window.clearTimeout(hideTimer);
        hideTimer = 0;
      }
    };
    const scheduleHide = () => {
      cancelHide();
      hideTimer = window.setTimeout(() => {
        hideTimer = 0;
        // The cursor may have re-entered after the timer was armed; only hide if
        // it is genuinely outside the container.
        if (!hovered) hide();
      }, HOLD_MS);
    };

    const onEnter = () => {
      hovered = true;
      cancelHide();
      show();
    };
    const onLeave = () => {
      hovered = false;
      scheduleHide();
    };
    const onScroll = () => {
      show();
      // While hovered the cursor keeps it alive; otherwise (keyboard / momentum
      // scroll with the pointer elsewhere) start the 4s countdown afresh.
      if (!hovered) scheduleHide();
    };

    hide(); // start idle
    el.addEventListener('mouseenter', onEnter);
    el.addEventListener('mouseleave', onLeave);
    el.addEventListener('scroll', onScroll, { passive: true });

    cleanupRef.current = () => {
      cancelHide();
      el.removeEventListener('mouseenter', onEnter);
      el.removeEventListener('mouseleave', onLeave);
      el.removeEventListener('scroll', onScroll);
    };
  }, []);
}
