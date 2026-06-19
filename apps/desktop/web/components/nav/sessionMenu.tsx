import {
  Archive,
  ArrowCounterClockwise,
  BookmarkSimple,
  PencilSimple,
} from '@phosphor-icons/react';

import { hasCustomTitle } from '../../domain';
import type { ShellSession } from '../../domain';
import type { NavMenuItem } from './NavContextMenu';

// The per-action callbacks a session's right-click menu invokes. Each is already
// bound to the session by the caller, so the builder stays agnostic about where
// the session lives (a left-nav row or a dashboard card) and only decides which
// items to show and how to render them.
export interface SessionMenuHandlers {
  onRename: () => void;
  onUseAutomaticName: () => void;
  // Toggle the follow-up flag. The builder picks the label/icon from
  // `state.followingUp`; the caller does the actual set/clear.
  onToggleFollowUp: () => void;
  onArchive: () => void;
}

// State the menu reads (vs. acts on) to label its toggles. Kept separate from the
// handlers so the builder stays a pure function of (session, state, handlers).
export interface SessionMenuState {
  // Whether this session currently carries a live follow-up flag, so the toggle
  // reads "Clear follow-up" instead of "Mark for follow-up".
  followingUp: boolean;
}

// The single source of truth for a session's context menu, shared by the left nav
// and every dashboard so a right-click on a session reads identically wherever it
// appears: rename, optionally reset to the automatic name (only when a custom name
// is pinned), then the single removal action. Folder utilities (reveal, copy path)
// live on the project menu, not here: a session's cwd is a detail of where it runs,
// not the durable folder a user manages. Archive is reversible everywhere in
// Reverie, so it is the one removal the menu offers; permanent deletion lives only
// in the deliberate, gated places (Settings, the archived lists), never here.
export function buildSessionMenuItems(
  session: ShellSession,
  state: SessionMenuState,
  handlers: SessionMenuHandlers,
): NavMenuItem[] {
  const items: NavMenuItem[] = [
    {
      id: 'rename',
      label: 'Rename',
      icon: <PencilSimple size={15} />,
      onSelect: handlers.onRename,
    },
  ];
  if (hasCustomTitle(session)) {
    items.push({
      id: 'auto-name',
      label: 'Use automatic name',
      icon: <ArrowCounterClockwise size={15} />,
      onSelect: handlers.onUseAutomaticName,
    });
  }
  // Follow-up: the durable, user-applied "come back to this" flag. A toggle, so
  // the same row clears it when already set. A filled bookmark reads as "marked".
  items.push({
    id: 'follow-up',
    label: state.followingUp ? 'Clear follow-up' : 'Mark for follow-up',
    icon: <BookmarkSimple size={15} weight={state.followingUp ? 'fill' : 'regular'} />,
    dividerBefore: true,
    onSelect: handlers.onToggleFollowUp,
  });
  items.push({
    id: 'archive',
    label: 'Archive session',
    icon: <Archive size={15} />,
    danger: true,
    dividerBefore: true,
    onSelect: handlers.onArchive,
  });
  return items;
}
