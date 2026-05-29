import { Folder } from '@phosphor-icons/react';

import { css } from '../../styled-system/css';
import { agentLabel, folderNameFromPath } from '../../domain';
import type {
  AgentCliDetection,
  AgentKind,
  CreationMode,
  ShellFocus,
  ShellProject,
} from '../../domain';
import { AgentGlyph } from '../glyphs';
import { primaryComposerButtonClass, secondaryComposerButtonClass } from '../primitives/buttons';
import { cliChoiceClass, cliChoiceGridClass } from '../primitives/cliChoice';

// The create-project / create-focus / create-session form, shown in the main
// surface when a creation mode is active. Field state + submit handlers live in
// the App shell (the new-session prefs are shared with Settings), so this is a
// controlled, prop-driven form.
export function CreationComposer({
  mode,
  selectedProject,
  selectedFocus,
  newProjectName,
  setNewProjectName,
  newProjectPath,
  setNewProjectPath,
  newFocusTitle,
  setNewFocusTitle,
  newSessionTitle,
  setNewSessionTitle,
  newSessionCwd,
  setNewSessionCwd,
  newSessionAgentKind,
  setNewSessionAgentKind,
  newSessionDangerousMode,
  setNewSessionDangerousMode,
  cliDetections,
  busy,
  onChooseProjectFolder,
  onCreateProject,
  onCreateFocus,
  onCreateSession,
  onCancel,
}: {
  mode: NonNullable<CreationMode>;
  selectedProject: ShellProject | null;
  selectedFocus: ShellFocus | null;
  newProjectName: string;
  setNewProjectName: (value: string) => void;
  newProjectPath: string;
  setNewProjectPath: (value: string) => void;
  newFocusTitle: string;
  setNewFocusTitle: (value: string) => void;
  newSessionTitle: string;
  setNewSessionTitle: (value: string) => void;
  newSessionCwd: string;
  setNewSessionCwd: (value: string) => void;
  newSessionAgentKind: AgentKind;
  setNewSessionAgentKind: (value: AgentKind) => void;
  newSessionDangerousMode: boolean;
  setNewSessionDangerousMode: (value: boolean) => void;
  cliDetections: AgentCliDetection[];
  busy: boolean;
  onChooseProjectFolder: () => void;
  onCreateProject: () => void;
  onCreateFocus: () => void;
  onCreateSession: () => void;
  onCancel: () => void;
}) {
  // A CLI is offered only when it is both detected and switched on in settings.
  // Switched-off CLIs are hidden from the picker entirely; not-detected (but
  // on) CLIs still show, greyed, so the user knows what Reverie supports.
  const isUsable = (detection: AgentCliDetection) => detection.available && detection.enabled;
  const selectedDetection = cliDetections.find(detection => detection.kind === newSessionAgentKind);
  const visibleDetections = cliDetections.filter(detection => detection.enabled);
  const usableDetections = visibleDetections.filter(isUsable);
  const availableCliCount = usableDetections.length;
  const selectedUsable = selectedDetection ? isUsable(selectedDetection) : false;
  const selectedExecutable =
    selectedDetection?.executable ?? selectedDetection?.candidates[0] ?? null;
  const selectedCliSummary = selectedUsable
    ? `${selectedDetection!.displayName} is ready${selectedExecutable ? ` at ${selectedExecutable}` : ''}.`
    : selectedDetection
      ? `${selectedDetection.displayName} is not available. Reverie will not create a session with a missing CLI.`
      : 'Pick one detected CLI before creating a session.';
  const canCreateSession = Boolean(
    selectedFocus && newSessionCwd.trim().length > 0 && availableCliCount > 0 && selectedUsable,
  );
  const sessionBlocker = !selectedFocus
    ? 'Choose or create a focus before creating a session.'
    : availableCliCount === 0
      ? 'No supported CLIs are currently enabled. Install Cortex, Claude Code, or Codex CLI and turn it on in Settings, then retry.'
      : !selectedUsable
        ? `${selectedDetection?.displayName ?? 'Selected CLI'} is not available on this machine.`
        : newSessionCwd.trim().length === 0
          ? 'Working directory is required.'
          : null;

  return (
    <section className={creationComposerClass} data-testid="creation-composer" data-mode={mode}>
      <div className={creationHeaderClass}>
        <span>
          {mode === 'project' ? 'New project' : mode === 'focus' ? 'New focus' : 'New session'}
        </span>
        <button type="button" data-testid="close-creation-composer" onClick={onCancel}>
          Close
        </button>
      </div>

      {mode === 'project' ? (
        <div className={creationGridClass}>
          <div
            className={folderPickerCardClass}
            data-testid="project-folder-selection"
            data-selected={newProjectPath.trim().length > 0 ? 'true' : 'false'}
          >
            <Folder size={18} />
            <span>
              {newProjectPath.trim().length > 0
                ? newProjectName || folderNameFromPath(newProjectPath) || 'Selected folder'
                : 'Choose a project folder'}
            </span>
            <small>
              {newProjectPath.trim().length > 0
                ? newProjectPath
                : 'Reverie will name the project from the folder and use that folder as the session working directory.'}
            </small>
          </div>
          <button
            className={secondaryComposerButtonClass}
            type="button"
            data-testid="choose-project-folder-button"
            disabled={busy}
            onClick={onChooseProjectFolder}
          >
            {newProjectPath.trim().length > 0 ? 'Choose different folder' : 'Choose folder…'}
          </button>
          <p className={composerHintClass} data-testid="project-form-hint">
            Projects start from a local folder selection, not manual path entry. New sessions under
            the project inherit that cwd.
          </p>
          <button
            className={primaryComposerButtonClass}
            type="button"
            data-testid="submit-project-button"
            disabled={busy || newProjectPath.trim().length === 0}
            onClick={onCreateProject}
          >
            {busy ? 'Creating…' : 'Add project'}
          </button>
        </div>
      ) : null}

      {mode === 'focus' ? (
        <div className={creationGridClass}>
          <p className={creationContextClass}>
            Project: <strong>{selectedProject?.name ?? 'General workspace'}</strong>
          </p>
          <label>
            Focus title
            <input
              data-testid="focus-title-input"
              value={newFocusTitle}
              placeholder="Terminal rendering"
              required
              onChange={event => setNewFocusTitle(event.currentTarget.value)}
            />
          </label>
          <p className={composerHintClass} data-testid="focus-form-hint">
            A focus is the durable thread sessions will attach to.
          </p>
          <button
            className={primaryComposerButtonClass}
            type="button"
            data-testid="submit-focus-button"
            disabled={busy || newFocusTitle.trim().length === 0}
            onClick={onCreateFocus}
          >
            {busy ? 'Creating…' : 'Create focus'}
          </button>
        </div>
      ) : null}

      {mode === 'session' ? (
        <div className={creationGridClass}>
          <p className={creationContextClass}>
            Focus: <strong>{selectedFocus?.title ?? 'Choose a focus first'}</strong>
          </p>
          <label>
            Session title
            <input
              data-testid="session-title-input"
              value={newSessionTitle}
              placeholder={`${agentLabel(newSessionAgentKind)} session`}
              onChange={event => setNewSessionTitle(event.currentTarget.value)}
            />
          </label>
          <label>
            Working directory
            <input
              data-testid="session-cwd-input"
              value={newSessionCwd}
              required
              onChange={event => setNewSessionCwd(event.currentTarget.value)}
            />
          </label>
          <p className={composerHintClass} data-testid="session-form-hint">
            {sessionBlocker ??
              `${selectedDetection?.displayName ?? 'Selected CLI'} will launch from this directory.`}
          </p>
          <div
            className={selectedCliSummaryClass({
              available: selectedDetection?.available ?? false,
            })}
            data-testid="selected-cli-summary"
          >
            <span>Selected agent</span>
            <strong>{selectedDetection?.displayName ?? 'No CLI selected'}</strong>
            <small>{selectedCliSummary}</small>
          </div>
          <div className={cliChoiceHeaderClass}>
            <span>Choose agent CLI</span>
            <small data-testid="cli-availability-summary">
              {availableCliCount === 0
                ? 'No supported CLIs enabled'
                : `${availableCliCount} of ${visibleDetections.length} ready`}
            </small>
          </div>
          <div
            className={cliChoiceGridClass}
            data-testid="cli-choice-list"
            aria-label="Detected CLI choices"
          >
            {visibleDetections.map(detection => {
              const active = detection.kind === newSessionAgentKind;
              const detectedText =
                detection.executable ?? detection.candidates[0] ?? 'Detected on PATH';
              return (
                <button
                  key={detection.kind}
                  type="button"
                  className={cliChoiceClass({ active, available: detection.available })}
                  data-testid="cli-choice"
                  data-cli-kind={detection.kind}
                  data-available={detection.available ? 'true' : 'false'}
                  data-selected={active ? 'true' : 'false'}
                  aria-pressed={active}
                  title={
                    detection.available
                      ? `${detection.displayName} detected at ${detectedText}`
                      : `${detection.displayName} is not installed or not on PATH`
                  }
                  disabled={!detection.available}
                  onClick={() => setNewSessionAgentKind(detection.kind)}
                >
                  <AgentGlyph kind={detection.kind} />
                  <span>
                    <strong>{detection.displayName}</strong>
                    <small>
                      {detection.available
                        ? detectedText
                        : `Missing: ${detection.candidates.join(', ')}`}
                    </small>
                  </span>
                  <em>{active ? 'Selected' : detection.available ? 'Ready' : 'Unavailable'}</em>
                </button>
              );
            })}
          </div>
          {availableCliCount === 0 ? (
            <p className={cliEmptyHelpClass} data-testid="cli-empty-help">
              Reverie can still organize projects and focuses, but sessions stay disabled until at
              least one supported agent CLI is installed and detected.
            </p>
          ) : null}
          <label className={checkRowClass}>
            <input
              data-testid="session-dangerous-checkbox"
              type="checkbox"
              checked={newSessionDangerousMode}
              onChange={event => setNewSessionDangerousMode(event.currentTarget.checked)}
            />{' '}
            Enable YOLO for this session
          </label>
          <button
            className={primaryComposerButtonClass}
            type="button"
            data-testid="submit-session-button"
            disabled={busy || !canCreateSession}
            onClick={onCreateSession}
          >
            {busy ? 'Creating…' : 'Create session'}
          </button>
        </div>
      ) : null}
    </section>
  );
}

const creationComposerClass = css({
  margin: '0',
  padding: '24px 26px',
  minHeight: '100%',
  alignContent: 'start',
  background: 'transparent',
  display: 'grid',
  gap: '16px',
});

const creationHeaderClass = css({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '12px',
  color: 'var(--text)',
  '& span': {
    fontSize: '12px',
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    color: 'var(--text-3)',
  },
  '& button': {
    border: '1px solid var(--line)',
    borderRadius: '999px',
    padding: '5px 9px',
    color: 'var(--text-2)',
    background: 'var(--surface-1)',
    cursor: 'pointer',
  },
});

const creationGridClass = css({
  display: 'grid',
  gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
  gap: '10px',
  alignItems: 'end',
  '& label': {
    display: 'grid',
    gap: '6px',
    color: 'var(--text-3)',
    fontSize: '12px',
  },
  '& input': {
    height: '34px',
    border: '1px solid var(--line)',
    borderRadius: '10px',
    padding: '0 10px',
    background: 'var(--surface-1)',
    color: 'var(--text)',
    outline: 'none',
  },
  mdDown: { gridTemplateColumns: '1fr' },
});

const creationContextClass = css({
  margin: 0,
  color: 'var(--text-3)',
  fontSize: '12px',
  alignSelf: 'center',
  '& strong': { color: 'var(--text-2)', fontWeight: 500 },
});

const composerHintClass = css({
  margin: 0,
  color: 'var(--text-3)',
  fontSize: '11.5px',
  lineHeight: 1.45,
  alignSelf: 'center',
});

const folderPickerCardClass = css({
  gridColumn: '1 / -1',
  display: 'grid',
  gridTemplateColumns: 'auto 1fr',
  gap: '3px 10px',
  alignItems: 'center',
  minHeight: '76px',
  padding: '13px 14px',
  borderRadius: '16px',
  border: '1px dashed var(--line-strong)',
  background: 'rgba(0,0,0,0.18)',
  color: 'var(--text)',
  '& svg': { color: 'var(--text-3)', gridRow: '1 / span 2' },
  '& span': { fontSize: '14px', fontWeight: 650 },
  '& small': {
    color: 'var(--text-3)',
    fontSize: '11.5px',
    lineHeight: 1.45,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
});

function selectedCliSummaryClass({ available }: { available: boolean }) {
  return css({
    gridColumn: '1 / -1',
    display: 'grid',
    gridTemplateColumns: 'auto 1fr',
    gap: '3px 10px',
    alignItems: 'center',
    padding: '10px 12px',
    borderRadius: '14px',
    border: `1px solid ${available ? 'color-mix(in srgb, var(--line-strong) 82%, var(--accent))' : 'var(--line)'}`,
    background: available
      ? 'linear-gradient(135deg, color-mix(in srgb, var(--surface-hi) 78%, transparent), color-mix(in srgb, var(--accent) 8%, transparent))'
      : 'var(--surface-1)',
    '& span': {
      color: 'var(--text-3)',
      fontSize: '11px',
      letterSpacing: '0.08em',
      textTransform: 'uppercase',
    },
    '& strong': { color: 'var(--text)', fontSize: '13px' },
    '& small': {
      gridColumn: '1 / -1',
      color: available ? 'var(--text-2)' : 'var(--text-4)',
      fontSize: '11.5px',
      lineHeight: 1.45,
    },
  });
}

const cliChoiceHeaderClass = css({
  gridColumn: '1 / -1',
  display: 'flex',
  justifyContent: 'space-between',
  gap: '12px',
  alignItems: 'center',
  color: 'var(--text-3)',
  fontSize: '11px',
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  '& small': { letterSpacing: '0', textTransform: 'none', color: 'var(--text-4)' },
});

const cliEmptyHelpClass = css({
  gridColumn: '1 / -1',
  margin: 0,
  padding: '10px 12px',
  borderRadius: '14px',
  border: '1px solid var(--line)',
  background: 'var(--surface-1)',
  color: 'var(--text-3)',
  fontSize: '11.5px',
  lineHeight: 1.5,
});

const checkRowClass = css({
  display: 'flex! important',
  alignItems: 'center',
  gap: '8px',
  textTransform: 'none! important',
  letterSpacing: '0! important',
  color: 'var(--text-2)! important',
  '& input': { width: 'auto! important' },
});
