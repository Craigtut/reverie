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
import { Typography } from '../primitives/Typography';

// The create-project / create-focus / create-session form, shown in the main
// surface when a creation mode is active. Field state + submit handlers live in
// the App shell (the new-session prefs are shared with Settings), so this is a
// controlled, prop-driven form.
export function CreationComposer({
  mode,
  selectedProject,
  selectedFocus,
  newProjectName,
  newProjectPath,
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
  newProjectPath: string;
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
    ? `${selectedDetection?.displayName} is ready${selectedExecutable ? ` at ${selectedExecutable}` : ''}.`
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
        <Typography
          as="span"
          variant="caption"
          tone="faint"
          uppercase
          style={{ letterSpacing: '0.08em' }}
        >
          {mode === 'project' ? 'New project' : mode === 'focus' ? 'New focus' : 'New session'}
        </Typography>
        <button type="button" data-testid="close-creation-composer" onClick={onCancel}>
          <Typography as="span" variant="smallBody" tone="inherit">
            Close
          </Typography>
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
            <Typography as="span" variant="smallBodyAlt" tone="inherit">
              {newProjectPath.trim().length > 0
                ? newProjectName || folderNameFromPath(newProjectPath) || 'Selected folder'
                : 'Choose a project folder'}
            </Typography>
            <Typography
              as="small"
              variant="caption"
              tone="faint"
              truncate
              style={{ lineHeight: 1.45 }}
            >
              {newProjectPath.trim().length > 0
                ? newProjectPath
                : 'Reverie will name the project from the folder and use that folder as the session working directory.'}
            </Typography>
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
          <Typography
            as="p"
            variant="caption"
            tone="faint"
            className={composerHintClass}
            data-testid="project-form-hint"
            style={{ lineHeight: 1.45 }}
          >
            Projects start from a local folder selection, not manual path entry. New sessions under
            the project inherit that cwd.
          </Typography>
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
          <Typography as="p" variant="caption" tone="faint" className={creationContextClass}>
            Project:{' '}
            <Typography as="strong" variant="caption" tone="muted">
              {selectedProject?.name ?? 'General workspace'}
            </Typography>
          </Typography>
          <label>
            <Typography as="span" variant="caption" tone="faint">
              Focus title
            </Typography>
            <input
              data-testid="focus-title-input"
              value={newFocusTitle}
              placeholder="Terminal rendering"
              required
              onChange={event => setNewFocusTitle(event.currentTarget.value)}
            />
          </label>
          <Typography
            as="p"
            variant="caption"
            tone="faint"
            className={composerHintClass}
            data-testid="focus-form-hint"
            style={{ lineHeight: 1.45 }}
          >
            A focus is the durable thread sessions will attach to.
          </Typography>
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
          <Typography as="p" variant="caption" tone="faint" className={creationContextClass}>
            Focus:{' '}
            <Typography as="strong" variant="caption" tone="muted">
              {selectedFocus?.title ?? 'Choose a focus first'}
            </Typography>
          </Typography>
          <label>
            <Typography as="span" variant="caption" tone="faint">
              Session title
            </Typography>
            <input
              data-testid="session-title-input"
              value={newSessionTitle}
              placeholder={`${agentLabel(newSessionAgentKind)} session`}
              onChange={event => setNewSessionTitle(event.currentTarget.value)}
            />
          </label>
          <label>
            <Typography as="span" variant="caption" tone="faint">
              Working directory
            </Typography>
            <input
              data-testid="session-cwd-input"
              value={newSessionCwd}
              required
              onChange={event => setNewSessionCwd(event.currentTarget.value)}
            />
          </label>
          <Typography
            as="p"
            variant="caption"
            tone="faint"
            className={composerHintClass}
            data-testid="session-form-hint"
            style={{ lineHeight: 1.45 }}
          >
            {sessionBlocker ??
              `${selectedDetection?.displayName ?? 'Selected CLI'} will launch from this directory.`}
          </Typography>
          <div
            className={selectedCliSummaryClass({
              available: selectedDetection?.available ?? false,
            })}
            data-testid="selected-cli-summary"
          >
            <Typography
              as="span"
              variant="caption"
              tone="faint"
              uppercase
              style={{ letterSpacing: '0.08em' }}
            >
              Selected agent
            </Typography>
            <Typography as="strong" variant="smallBodyAlt" tone="default">
              {selectedDetection?.displayName ?? 'No CLI selected'}
            </Typography>
            <Typography
              as="small"
              variant="caption"
              tone={selectedDetection?.available ? 'muted' : 'ghost'}
              className={selectedCliSummaryDetailClass}
              style={{ lineHeight: 1.45 }}
            >
              {selectedCliSummary}
            </Typography>
          </div>
          <div className={cliChoiceHeaderClass}>
            <Typography
              as="span"
              variant="caption"
              tone="faint"
              uppercase
              style={{ letterSpacing: '0.08em' }}
            >
              Choose agent CLI
            </Typography>
            <Typography
              as="small"
              variant="caption"
              tone="ghost"
              data-testid="cli-availability-summary"
            >
              {availableCliCount === 0
                ? 'No supported CLIs enabled'
                : `${availableCliCount} of ${visibleDetections.length} ready`}
            </Typography>
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
            <Typography
              as="p"
              variant="caption"
              tone="faint"
              className={cliEmptyHelpClass}
              data-testid="cli-empty-help"
              style={{ lineHeight: 1.5 }}
            >
              Reverie can still organize projects and focuses, but sessions stay disabled until at
              least one supported agent CLI is installed and detected.
            </Typography>
          ) : null}
          <label className={checkRowClass}>
            <input
              data-testid="session-dangerous-checkbox"
              type="checkbox"
              checked={newSessionDangerousMode}
              onChange={event => setNewSessionDangerousMode(event.currentTarget.checked)}
            />{' '}
            <Typography as="span" variant="smallBody" tone="inherit">
              Enable YOLO for this session
            </Typography>
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
  alignSelf: 'center',
});

const composerHintClass = css({
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
  });
}

// Layout residual for the summary detail line; size + color come from the
// Typography variant + tone the summary renders.
const selectedCliSummaryDetailClass = css({
  gridColumn: '1 / -1',
});

const cliChoiceHeaderClass = css({
  gridColumn: '1 / -1',
  display: 'flex',
  justifyContent: 'space-between',
  gap: '12px',
  alignItems: 'center',
});

const cliEmptyHelpClass = css({
  gridColumn: '1 / -1',
  padding: '10px 12px',
  borderRadius: '14px',
  border: '1px solid var(--line)',
  background: 'var(--surface-1)',
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
