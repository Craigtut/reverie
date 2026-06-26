import type { CreationMode, SessionTerminalBinding, SurfaceMode } from './types';

// The terminal renderer is a singleton island: one canvas, one controller, and a
// single `activeTerminalId` that decides whose frame stream paints to that canvas
// and receives input. That claim MUST track the session currently shown on the
// terminal surface, and point at nothing when no session is shown. Historically it
// was mutated imperatively from each launch/activate/teardown path, and no
// navigation path released it: leaving a live session for a dashboard left the
// claim behind, so the backgrounded session kept ingesting its stream as the
// active paint target against an unmounted canvas (a perpetual history-fetch
// storm) and could wedge the view so it stayed black on return.
//
// `deriveActiveTerminalClaim` makes the claim a pure function of the displayed
// session instead. One effect applies it on every relevant change, so the claim
// can never be stranded by a navigation path that forgot to clear it.
export interface ActiveTerminalClaim {
  // The terminal whose stream should paint + take input, or null when no session
  // is displayed (or the displayed one has no live terminal yet).
  terminalId: string | null;
  // Whether that terminal is ready for keystrokes. False whenever the claim is
  // released, so input is never routed to a process the user is not looking at.
  inputArmed: boolean;
}

// A session is "displayed" only on the terminal surface itself, not while a
// creation composer is open over it and not on a dashboard/settings/history view
// (which unmount the terminal entirely).
export function isTerminalSessionDisplayed(input: {
  surfaceMode: SurfaceMode;
  creationMode: CreationMode;
  selectedSessionId: string | null;
}): boolean {
  return (
    input.surfaceMode === 'terminal' && !input.creationMode && Boolean(input.selectedSessionId)
  );
}

export function deriveActiveTerminalClaim(input: {
  surfaceMode: SurfaceMode;
  creationMode: CreationMode;
  selectedSessionId: string | null;
  // The terminal binding of the selected session, if it has launched/resumed.
  binding: SessionTerminalBinding | null | undefined;
}): ActiveTerminalClaim {
  if (!isTerminalSessionDisplayed(input) || !input.binding) {
    return { terminalId: null, inputArmed: false };
  }
  return { terminalId: input.binding.terminalId, inputArmed: input.binding.inputArmed };
}
