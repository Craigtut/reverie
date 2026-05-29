import { useEffect } from 'react';

import { useUiStore } from '../store';

// Track whether Reverie is the focused app and mirror it into the UI store.
// Shell-level motion (the breathing/attention glyphs) pauses whenever Reverie
// is not focused, so a backgrounded window stops driving the compositor;
// glyphs resume seamlessly on focus via animation-play-state.
export function useAppFocus() {
  const setAppFocused = useUiStore(s => s.setAppFocused);

  useEffect(() => {
    const onFocus = () => setAppFocused(true);
    const onBlur = () => setAppFocused(false);
    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', onBlur);
    setAppFocused(document.hasFocus());
    return () => {
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', onBlur);
    };
  }, [setAppFocused]);
}
