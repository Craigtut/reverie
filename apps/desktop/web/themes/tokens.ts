// Theme mode for the warm-neutral palette.
//
// The actual palette values (the --bg / --text / --good / ... CSS custom
// properties for both dark and light) live inline in themes/appShell.ts, which
// mounts them on the shell element and switches them via [data-theme]. They are
// declared there, not here, because Panda's build-time extractor cannot resolve
// a spread of an imported object into css() (see [[panda-cross-file-spread]]),
// so the declarations must sit in that css() literal to be emitted.
//
// Design rule (see docs/design-vision.md): monochrome + status colors only.
// --good / --warn / --bad are the only hues; everything else is warm-neutral.

export type ThemeMode = 'dark' | 'light';
