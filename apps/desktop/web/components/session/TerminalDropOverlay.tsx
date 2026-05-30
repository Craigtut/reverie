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
export function TerminalDropOverlay({ model, session }: TerminalDropOverlayProps) {
  return (
    <DropSurface
      model={model}
      zone={TERMINAL_DROP_ZONE}
      icon={<AgentGlyph kind={session.agentKind} />}
      label={`Drop into ${agentLabel(session.agentKind)}`}
      sublabel={session.title}
      invalidLabel="Session not running"
      invalidSublabel="Start the session to drop a file here"
    />
  );
}
