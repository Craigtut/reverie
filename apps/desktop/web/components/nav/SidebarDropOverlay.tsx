import { Folder } from '@phosphor-icons/react';

import type { FileDropModel } from '../../hooks';
import { SIDEBAR_PROJECT_DROP_ZONE } from '../../hooks';
import { DropSurface } from '../dnd';

// The left-panel project drop visual: a contained dot field scoped to the sidebar
// (no full-window bleed) with an "Add as project" plate centered over the rail.
// armedLevel 0 keeps the field down until the cursor is actually over the panel,
// so a folder drag lights up only the left panel. All motion lives in DropSurface;
// the drop itself creates the project (see Sidebar / useWorkspaceMutations).
export function SidebarDropOverlay({ model }: { model: FileDropModel }) {
  return (
    <DropSurface
      model={model}
      zone={SIDEBAR_PROJECT_DROP_ZONE}
      contain
      armedLevel={0}
      icon={<Folder size={18} weight="duotone" />}
      label="Add as project"
      sublabel="Drop a folder here"
    />
  );
}
