import { useFileDrop, type FileDropModel } from './useFileDrop';

// Sidebar adapter over the generic useFileDrop: a folder dropped anywhere on the
// left panel becomes a new project. The whole <aside> is the zone (a big, forgiving
// target) and the visual is confined to it (DropSurface `contain`), so the dot
// field never bleeds onto the rest of the app.
//
// Folder-vs-file can't be told apart in the webview mid-drag (no filesystem
// access), so any path is accepted during the drag and the backend enforces the
// folder-only rule on release: a dropped file or missing path is rejected with a
// toast (see useWorkspaceMutations.addProjectsFromDroppedFolders).

export const SIDEBAR_PROJECT_DROP_ZONE = 'sidebar-project';

export interface SidebarFolderDropOptions {
  onDropFolders: (paths: string[]) => void;
}

export function useSidebarFolderDrop({ onDropFolders }: SidebarFolderDropOptions): FileDropModel {
  return useFileDrop({
    accepts: kind => kind === SIDEBAR_PROJECT_DROP_ZONE,
    isValidTarget: () => true,
    onDrop: (_target, paths) => onDropFolders(paths),
  });
}
