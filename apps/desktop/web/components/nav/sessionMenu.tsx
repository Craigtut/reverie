import {
  Archive,
  ArrowCounterClockwise,
  Copy,
  FolderOpen,
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
  onRevealPath: (path: string) => void;
  onCopyPath: (path: string) => void;
  onArchive: () => void;
}

// The single source of truth for a session's context menu, shared by the left nav
// and every dashboard so a right-click on a session reads identically wherever it
// appears: rename, optionally reset to the automatic name (only when a custom name
// is pinned), the folder utilities (sessions always have a cwd), then the single
// removal action. Archive is reversible everywhere in Reverie, so it is the one
// removal the menu offers; permanent deletion lives only in the deliberate, gated
// places (Settings, the archived lists), never here.
export function buildSessionMenuItems(
  session: ShellSession,
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
  if (session.cwd) {
    items.push({
      id: 'reveal',
      label: 'Reveal folder in Finder',
      icon: <FolderOpen size={15} />,
      dividerBefore: true,
      onSelect: () => handlers.onRevealPath(session.cwd),
    });
    items.push({
      id: 'copy-path',
      label: 'Copy folder path',
      icon: <Copy size={15} />,
      onSelect: () => handlers.onCopyPath(session.cwd),
    });
  }
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
