import { useEffect, useRef, useState } from 'react';

import {
  appRuntimeMode,
  onFileDrop,
  type FileDropEvent,
  type UnlistenFn,
} from '../services/runtime';

// Generic, domain-free controller for native file drag-drop onto marked zones.
// It bridges the OS drag-drop events, resolves which zone the cursor is over,
// drives a small state machine (the drop overlay reads it), and on release calls
// the caller's onDrop. It knows nothing about terminals or projects: a consumer
// marks its drop zones in the DOM and supplies the policy (which zones it cares
// about, what counts as a valid target, what to do on drop).
//
// Mark a drop zone in the DOM with two data attributes:
//   <div data-drop-zone="project" data-drop-id={project.id}> ... </div>
// `kind` (data-drop-zone) groups zones; `id` (data-drop-id) identifies one.
//
// Render <DropSurface> over the zone, passing this hook's model, to get the
// dot-field rise + gravity-well + droplet ripple visual. Example:
//   const model = useFileDrop({
//     accepts: kind => kind === 'project',
//     isValidTarget: () => true,
//     onDrop: (target, paths) => addProjectFromFolder(paths[0]),
//   });
//   return <div data-drop-zone="project" data-drop-id="...">
//            <YourContent />
//            <DropSurface model={model} zone="project" icon={<FolderIcon/>} label="Add as project" />
//          </div>;

export type FileDropPhase = 'idle' | 'armed' | 'over' | 'confirm';

export interface FileDropTarget {
  // The zone's kind (from data-drop-zone) and id (from data-drop-id).
  kind: string;
  id: string;
  // Whether the current drag may actually be dropped here (isValidTarget).
  valid: boolean;
}

export interface FileDropModel {
  // `armed`: a drag is loose in the window but not over an accepted zone.
  // `over`: the cursor is over one of this instance's accepted zones.
  // `confirm`: a drop just landed; held briefly so the splash can play.
  phase: FileDropPhase;
  target: FileDropTarget | null;
  // Pointer in viewport (clientX/clientY) CSS px, or null when no drag is live.
  pointer: { x: number; y: number } | null;
  files: string[];
  // Increments on every committed drop; the overlay keys its splash off this.
  dropCount: number;
}

export interface UseFileDropOptions {
  // Restrict which zone kinds this instance responds to, so independent drop
  // surfaces (e.g. the terminal and the project list) never fight over a drag.
  // Default: respond to every zone kind.
  accepts?: (kind: string) => boolean;
  // Whether the current drag may be dropped on a resolved zone (e.g. a running
  // session, a folder-only zone). Invalid targets still highlight but read as
  // "can't drop here". Default: always valid.
  isValidTarget?: (target: { kind: string; id: string }) => boolean;
  // Called once on a committed drop over a VALID target, with the dropped paths.
  onDrop?: (target: { kind: string; id: string }, paths: string[]) => void;
  // How long (ms) to hold the confirm phase so the splash / success can play.
  confirmMs?: number;
}

const IDLE_MODEL: FileDropModel = {
  phase: 'idle',
  target: null,
  pointer: null,
  files: [],
  dropCount: 0,
};

function resolveZoneAt(x: number, y: number): { kind: string; id: string } | null {
  // The overlay layer is pointer-events:none, so elementFromPoint reports the
  // zone beneath it; closest() walks up to the nearest marked drop zone.
  const el = document.elementFromPoint(x, y);
  const node = el?.closest<HTMLElement>('[data-drop-zone]');
  if (!node) return null;
  const kind = node.dataset.dropZone;
  if (!kind) return null;
  return { kind, id: node.dataset.dropId ?? '' };
}

export function useFileDrop(options: UseFileDropOptions = {}): FileDropModel {
  const [model, setModel] = useState<FileDropModel>(IDLE_MODEL);
  // Keep the latest carried paths so 'over' events (which omit paths) can keep
  // showing the carried chip, and the freshest options without re-subscribing.
  const filesRef = useRef<string[]>([]);
  const confirmTimer = useRef<number | null>(null);
  const optsRef = useRef(options);
  optsRef.current = options;

  useEffect(() => {
    let disposed = false;

    function clearConfirmTimer() {
      if (confirmTimer.current !== null) {
        window.clearTimeout(confirmTimer.current);
        confirmTimer.current = null;
      }
    }

    function reset() {
      filesRef.current = [];
      setModel(prev =>
        prev.phase === 'idle' ? prev : { ...IDLE_MODEL, dropCount: prev.dropCount },
      );
    }

    function resolveTarget(x: number, y: number): FileDropTarget | null {
      const zone = resolveZoneAt(x, y);
      if (!zone) return null;
      const accepts = optsRef.current.accepts ?? (() => true);
      if (!accepts(zone.kind)) return null;
      const isValid = optsRef.current.isValidTarget ?? (() => true);
      return { kind: zone.kind, id: zone.id, valid: isValid(zone) };
    }

    function handle(event: FileDropEvent) {
      if (disposed) return;
      if (event.type === 'leave') {
        clearConfirmTimer();
        reset();
        return;
      }

      const pointer = event.position;
      if (!pointer) return;
      const target = resolveTarget(pointer.x, pointer.y);

      if (event.type === 'enter' || event.type === 'over') {
        clearConfirmTimer();
        if (event.paths.length > 0) filesRef.current = event.paths;
        setModel(prev => ({
          phase: target ? 'over' : 'armed',
          target,
          pointer,
          files: filesRef.current,
          dropCount: prev.dropCount,
        }));
        return;
      }

      // event.type === 'drop'
      const paths = event.paths.length > 0 ? event.paths : filesRef.current;
      if (target?.valid && paths.length > 0) {
        optsRef.current.onDrop?.({ kind: target.kind, id: target.id }, paths);
      }
      clearConfirmTimer();
      setModel(prev => ({
        phase: 'confirm',
        target,
        pointer,
        files: paths,
        dropCount: prev.dropCount + 1,
      }));
      confirmTimer.current = window.setTimeout(() => {
        confirmTimer.current = null;
        reset();
      }, optsRef.current.confirmMs ?? 520);
    }

    // Native bridge (desktop app). In the browser harness this resolves to a
    // no-op unlisten; the HTML5 driver below feeds the same handler instead.
    let unlisten: UnlistenFn | null = null;
    void onFileDrop(handle).then(fn => {
      if (disposed) fn();
      else unlisten = fn;
    });

    let detachHarness: (() => void) | null = null;
    if (appRuntimeMode() === 'browser-fixture') {
      detachHarness = attachHarnessDriver(handle);
    }

    return () => {
      disposed = true;
      clearConfirmTimer();
      if (unlisten) unlisten();
      if (detachHarness) detachHarness();
    };
  }, []);

  return model;
}

// Harness-only: synthesize FileDropEvents from HTML5 drag events so drop
// surfaces can be developed and screenshotted in `npm run dev:harness`. The
// desktop app never reaches here (Tauri suppresses HTML5 file DnD while its
// native bridge is on). Real filesystem paths aren't exposed to the browser, so
// we fabricate plausible ones from the dragged file names to drive the visuals.
function attachHarnessDriver(handle: (event: FileDropEvent) => void): () => void {
  let depth = 0;

  function pathsFrom(transfer: DataTransfer | null): string[] {
    const names = transfer ? Array.from(transfer.files).map(f => f.name) : [];
    if (names.length > 0) return names.map(name => `/Users/you/Downloads/${name}`);
    return ['/Users/you/Downloads/example.txt'];
  }

  function onEnter(event: DragEvent) {
    event.preventDefault();
    depth += 1;
    if (depth === 1) {
      handle({
        type: 'enter',
        paths: pathsFrom(event.dataTransfer),
        position: { x: event.clientX, y: event.clientY },
      });
    }
  }

  function onOver(event: DragEvent) {
    event.preventDefault();
    handle({ type: 'over', paths: [], position: { x: event.clientX, y: event.clientY } });
  }

  function onLeave() {
    depth = Math.max(0, depth - 1);
    if (depth === 0) handle({ type: 'leave', paths: [], position: null });
  }

  function onDrop(event: DragEvent) {
    event.preventDefault();
    depth = 0;
    handle({
      type: 'drop',
      paths: pathsFrom(event.dataTransfer),
      position: { x: event.clientX, y: event.clientY },
    });
  }

  window.addEventListener('dragenter', onEnter);
  window.addEventListener('dragover', onOver);
  window.addEventListener('dragleave', onLeave);
  window.addEventListener('drop', onDrop);
  return () => {
    window.removeEventListener('dragenter', onEnter);
    window.removeEventListener('dragover', onOver);
    window.removeEventListener('dragleave', onLeave);
    window.removeEventListener('drop', onDrop);
  };
}
