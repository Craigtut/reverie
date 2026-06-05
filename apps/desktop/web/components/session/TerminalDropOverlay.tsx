import { agentLabel } from '../../domain';
import type { ShellSession } from '../../domain';
import type { FileDropModel } from '../../hooks';
import { TERMINAL_DROP_ZONE } from '../../hooks';
import { DropSurface } from '../dnd';
import { AgentGlyph } from '../glyphs';

export interface TerminalDropOverlayProps {
  model: FileDropModel;
  // The session on stage; it is the body drop target, so its identity drives the
  // destination plate.
  session: ShellSession;
}

// Terminal-flavored use of the reusable <DropSurface>: it supplies the plate
// (the session's AgentGlyph + "Drop into <agent>") and the not-running copy. All
// of the visual and motion lives in DropSurface / dropField.
//
// armedLevel 0 keeps the field down until the cursor is actually over the terminal
// or a tab, instead of the old full-window ambient whisper. That whisper spanned
// the app and would light up the terminal during a folder drag aimed at the left
// panel; with both fields scoped to their own zone, dragging a folder shows dots
// only on the rail, and dragging a file shows them only over the terminal.
export function TerminalDropOverlay({ model, session }: TerminalDropOverlayProps) {
  return (
    <DropSurface
      model={model}
      zone={TERMINAL_DROP_ZONE}
      armedLevel={0}
      icon={<AgentGlyph kind={session.agentKind} />}
      label={`Drop into ${agentLabel(session.agentKind)}`}
      sublabel={session.title}
      invalidLabel="Session not running"
      invalidSublabel="Start the session to drop a file here"
    />
  );
}
