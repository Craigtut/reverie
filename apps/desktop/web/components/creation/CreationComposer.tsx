import { useEffect, useRef, useState } from 'react';
import { ArrowRight, CaretRight, Folder, ShieldWarning } from '@phosphor-icons/react';

import { css } from '../../styled-system/css';
import { folderNameFromPath } from '../../domain';
import type {
  AgentCliDetection,
  AgentKind,
  CreationMode,
  ShellFocus,
  ShellProject,
} from '../../domain';
import { useFileDrop } from '../../hooks';
import { DropSurface } from '../dnd';
import { AgentGlyph } from '../glyphs';
import { primaryComposerButtonClass, secondaryComposerButtonClass } from '../primitives/buttons';
import { Typography } from '../primitives/Typography';

// Drop zone kind for the new-project folder well. Local to the composer; the
// terminal uses its own zone kinds.
const PROJECT_DROP_ZONE = 'project';

// The create-project / create-topic / create-session form, shown centered in the
// main surface when a creation mode is active. One calm shell across all three:
// an eyebrow for context, a hero, a single teaching line, then the one choice
// that matters. There is no Close button: Esc cancels and the left nav is always
// present. Field state + submit handlers live in the App shell, so this is a
// controlled, prop-driven form.
//
// Topic and session both commit by picking an agent tile: choosing an agent
// creates the record(s) and opens the terminal in one motion, so there is no
// separate submit button and no manual session naming.
export function CreationComposer({
  mode,
  selectedProject,
  selectedFocus,
  newProjectName,
  newProjectPath,
  newFocusTitle,
  setNewFocusTitle,
  newFocusDangerousMode,
  setNewFocusDangerousMode,
  newSessionCwd,
  setNewSessionCwd,
  newSessionDangerousMode,
  setNewSessionDangerousMode,
  cliDetections,
  busy,
  projectDropError,
  onChooseProjectFolder,
  onDropProjectFolder,
  onCreateProject,
  onCreateTopicWithAgent,
  onCreateSessionWithAgent,
  onCancel,
}: {
  mode: NonNullable<CreationMode>;
  selectedProject: ShellProject | null;
  selectedFocus: ShellFocus | null;
  newProjectName: string;
  newProjectPath: string;
  newFocusTitle: string;
  setNewFocusTitle: (value: string) => void;
  newFocusDangerousMode: boolean;
  setNewFocusDangerousMode: (value: boolean) => void;
  newSessionCwd: string;
  setNewSessionCwd: (value: string) => void;
  newSessionDangerousMode: boolean;
  setNewSessionDangerousMode: (value: boolean) => void;
  cliDetections: AgentCliDetection[];
  busy: boolean;
  projectDropError: string | null;
  onChooseProjectFolder: () => void;
  onDropProjectFolder: (path: string) => void;
  onCreateProject: () => void;
  onCreateTopicWithAgent: (kind: AgentKind) => void;
  onCreateSessionWithAgent: (kind: AgentKind) => void;
  onCancel: () => void;
}) {
  const eyebrow =
    mode === 'project'
      ? 'New project'
      : mode === 'focus'
        ? selectedProject
          ? `New topic · ${selectedProject.name}`
          : 'New topic'
        : selectedFocus
          ? `New session · ${selectedFocus.title}`
          : 'New session';

  const isProject = mode === 'project';

  // Project folder drag-drop covers the whole project background, not just the
  // dashed well: the entire composer section is the drop zone, so a folder
  // dropped anywhere over it selects it. The left nav is a separate element with
  // no project drop zone, so drops there never resolve here. The hook is always
  // mounted (hooks can't be conditional), but the zone only exists in project
  // mode, so drops only fire there.
  const projectDrop = useFileDrop({
    accepts: kind => kind === PROJECT_DROP_ZONE,
    isValidTarget: () => true,
    onDrop: (_target, paths) => {
      if (paths.length > 0) onDropProjectFolder(paths[0]);
    },
  });

  return (
    <section
      className={composerScrollClass}
      data-testid="creation-composer"
      data-mode={mode}
      {...(isProject ? { 'data-drop-zone': PROJECT_DROP_ZONE, 'data-drop-id': 'new-project' } : {})}
    >
      {isProject ? (
        <DropSurface
          model={projectDrop}
          zone={PROJECT_DROP_ZONE}
          icon={<Folder size={18} weight="duotone" />}
          label="Add as project"
          sublabel="Drop a folder anywhere here"
        />
      ) : null}
      <div className={composerColumnClass}>
        <Typography
          as="span"
          variant="caption"
          tone="faint"
          uppercase
          className={eyebrowClass}
          style={{ letterSpacing: '0.08em' }}
        >
          {eyebrow}
        </Typography>

        {mode === 'project' ? (
          <ProjectComposer
            newProjectName={newProjectName}
            newProjectPath={newProjectPath}
            busy={busy}
            projectDropError={projectDropError}
            onChooseProjectFolder={onChooseProjectFolder}
            onCreateProject={onCreateProject}
            onCancel={onCancel}
          />
        ) : mode === 'focus' ? (
          <TopicComposer
            newFocusTitle={newFocusTitle}
            setNewFocusTitle={setNewFocusTitle}
            newFocusDangerousMode={newFocusDangerousMode}
            setNewFocusDangerousMode={setNewFocusDangerousMode}
            cliDetections={cliDetections}
            busy={busy}
            onCreateTopicWithAgent={onCreateTopicWithAgent}
          />
        ) : (
          <SessionComposer
            selectedFocus={selectedFocus}
            newSessionCwd={newSessionCwd}
            setNewSessionCwd={setNewSessionCwd}
            newSessionDangerousMode={newSessionDangerousMode}
            setNewSessionDangerousMode={setNewSessionDangerousMode}
            cliDetections={cliDetections}
            busy={busy}
            onCreateSessionWithAgent={onCreateSessionWithAgent}
          />
        )}

        {/* Project mode renders Cancel in its own footer (bottom-left, balancing
            Add project on the right). Other modes keep the centered Cancel. */}
        {!isProject ? (
          <button
            type="button"
            className={cancelLinkClass}
            data-testid="cancel-creation"
            onClick={onCancel}
          >
            <Typography as="span" variant="caption" tone="faint">
              Cancel
            </Typography>
          </button>
        ) : null}
      </div>
    </section>
  );
}

// New project: the folder is the page. The dashed well is a fixed-size visual
// cue (and home of the "Choose folder" button), but the whole composer
// background is the drop zone (wired in CreationComposer), so a folder dropped
// anywhere over the page selects it. Once a folder is chosen the well collapses
// to a confirmed row; the footer pairs Cancel (bottom-left) with Add project
// (bottom-right) so they balance.
function ProjectComposer({
  newProjectName,
  newProjectPath,
  busy,
  projectDropError,
  onChooseProjectFolder,
  onCreateProject,
  onCancel,
}: {
  newProjectName: string;
  newProjectPath: string;
  busy: boolean;
  projectDropError: string | null;
  onChooseProjectFolder: () => void;
  onCreateProject: () => void;
  onCancel: () => void;
}) {
  const hasFolder = newProjectPath.trim().length > 0;

  return (
    <>
      <Typography as="h1" variant="title2" tone="default" className={heroClass}>
        Add a project
      </Typography>
      <Typography as="p" variant="smallBody" tone="faint" className={leadClass}>
        A project is a folder on your computer that gathers related work in one place. Your agent
        sessions will run inside it and have access to the files in the folder.
      </Typography>

      {hasFolder ? (
        <div
          className={chosenFolderCardClass}
          data-testid="project-folder-selection"
          data-selected="true"
        >
          <Folder size={20} weight="duotone" />
          <div className={chosenFolderTextClass}>
            <Typography as="strong" variant="smallBodyAlt" tone="default" truncate>
              {newProjectName || folderNameFromPath(newProjectPath) || 'Selected folder'}
            </Typography>
            <Typography as="small" variant="caption" tone="faint" truncate>
              {newProjectPath}
            </Typography>
          </div>
          <button
            type="button"
            className={changeFolderButtonClass}
            data-testid="choose-project-folder-button"
            disabled={busy}
            onClick={onChooseProjectFolder}
          >
            <Typography as="span" variant="caption" tone="inherit">
              Change
            </Typography>
          </button>
        </div>
      ) : (
        <div className={dropWellClass} data-testid="project-folder-selection" data-selected="false">
          <div className={dropWellInnerClass}>
            <Folder size={30} weight="duotone" />
            <Typography as="span" variant="smallBodyAlt" tone="default">
              Drop a folder here
            </Typography>
            <Typography as="span" variant="caption" tone="faint">
              or
            </Typography>
            <button
              type="button"
              className={secondaryComposerButtonClass}
              data-testid="choose-project-folder-button"
              disabled={busy}
              onClick={onChooseProjectFolder}
            >
              Choose folder…
            </button>
          </div>
        </div>
      )}

      {projectDropError ? (
        <Typography
          as="p"
          variant="caption"
          tone="bad"
          className={dropErrorClass}
          data-testid="project-drop-error"
        >
          {projectDropError}
        </Typography>
      ) : null}

      <div className={projectFooterClass}>
        <button
          type="button"
          className={cancelLinkClass}
          data-testid="cancel-creation"
          onClick={onCancel}
        >
          <Typography as="span" variant="caption" tone="faint">
            Cancel
          </Typography>
        </button>
        {hasFolder ? (
          <button
            type="button"
            className={primaryComposerButtonClass}
            data-testid="submit-project-button"
            disabled={busy}
            onClick={onCreateProject}
          >
            {busy ? 'Creating…' : 'Add project'} <ArrowRight size={14} weight="bold" />
          </button>
        ) : null}
      </div>
    </>
  );
}

// New topic: name the area of work, set its topic-wide auto-approve, then pick an
// agent to open the first session. The agent tiles are the commit.
function TopicComposer({
  newFocusTitle,
  setNewFocusTitle,
  newFocusDangerousMode,
  setNewFocusDangerousMode,
  cliDetections,
  busy,
  onCreateTopicWithAgent,
}: {
  newFocusTitle: string;
  setNewFocusTitle: (value: string) => void;
  newFocusDangerousMode: boolean;
  setNewFocusDangerousMode: (value: boolean) => void;
  cliDetections: AgentCliDetection[];
  busy: boolean;
  onCreateTopicWithAgent: (kind: AgentKind) => void;
}) {
  // Focus the topic name on mount (it is the primary field of a freshly opened
  // composer), done with a ref rather than the autoFocus attribute so it stays
  // lint-clean and only fires when this composer actually appears.
  const titleRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  return (
    <>
      <Typography as="h1" variant="title2" tone="default" className={heroClass}>
        What are you working on?
      </Typography>
      <Typography as="p" variant="smallBody" tone="faint" className={leadClass}>
        A topic keeps related sessions together so you can step away and pick up right where you
        left off. Branding, security updates, a launch: whatever you're focused on.
      </Typography>

      <input
        ref={titleRef}
        className={heroInputClass}
        data-testid="focus-title-input"
        value={newFocusTitle}
        placeholder="Name this topic"
        onChange={event => setNewFocusTitle(event.currentTarget.value)}
      />

      <AutoApproveToggle
        label="Auto-approve in this topic"
        help="Every session here starts this way. You can override any single session later."
        value={newFocusDangerousMode}
        onChange={setNewFocusDangerousMode}
        testIdPrefix="topic-auto-approve"
      />

      <div className={sectionDividerClass} />

      <AgentPicker
        heading="Start with"
        subheading="Pick an agent to open your first session."
        cliDetections={cliDetections}
        busy={busy}
        disabled={newFocusTitle.trim().length === 0}
        disabledHint="Name the topic first."
        onPick={onCreateTopicWithAgent}
      />
    </>
  );
}

// New session in an existing topic: pick an agent to open it. Power-user details
// (working directory, this session's auto-approve) live behind a quiet Options
// disclosure so the agent choice stays the focus.
function SessionComposer({
  selectedFocus,
  newSessionCwd,
  setNewSessionCwd,
  newSessionDangerousMode,
  setNewSessionDangerousMode,
  cliDetections,
  busy,
  onCreateSessionWithAgent,
}: {
  selectedFocus: ShellFocus | null;
  newSessionCwd: string;
  setNewSessionCwd: (value: string) => void;
  newSessionDangerousMode: boolean;
  setNewSessionDangerousMode: (value: boolean) => void;
  cliDetections: AgentCliDetection[];
  busy: boolean;
  onCreateSessionWithAgent: (kind: AgentKind) => void;
}) {
  const [optionsOpen, setOptionsOpen] = useState(false);
  const cwdLabel = newSessionCwd.trim();

  return (
    <>
      <Typography as="h1" variant="title2" tone="default" className={heroClass}>
        Start a session
      </Typography>
      <Typography as="p" variant="smallBody" tone="faint" className={leadClass}>
        {selectedFocus
          ? `Pick an agent. It opens in ${selectedFocus.title}${cwdLabel ? ` and works in ${cwdLabel}` : ''}.`
          : 'Pick a topic first, then choose an agent to open a session.'}
      </Typography>

      <AgentPicker
        cliDetections={cliDetections}
        busy={busy}
        disabled={!selectedFocus}
        disabledHint="Choose or create a topic first."
        onPick={onCreateSessionWithAgent}
      />

      <div className={optionsClass} data-open={optionsOpen ? 'true' : 'false'}>
        <button
          type="button"
          className={optionsToggleClass}
          data-testid="session-options-toggle"
          aria-expanded={optionsOpen}
          onClick={() => setOptionsOpen(open => !open)}
        >
          <CaretRight size={12} weight="bold" className={optionsCaretClass} />
          <Typography as="span" variant="caption" tone="faint">
            Options
          </Typography>
          <Typography as="span" variant="caption" tone="ghost">
            working directory · auto-approve
          </Typography>
        </button>

        {optionsOpen ? (
          <div className={optionsBodyClass}>
            <label className={fieldLabelClass}>
              <Typography as="span" variant="caption" tone="faint">
                Working directory
              </Typography>
              <input
                className={fieldInputClass}
                data-testid="session-cwd-input"
                value={newSessionCwd}
                onChange={event => setNewSessionCwd(event.currentTarget.value)}
              />
            </label>
            <AutoApproveToggle
              label="Auto-approve this session"
              help="Overrides the topic default for this one session."
              value={newSessionDangerousMode}
              onChange={setNewSessionDangerousMode}
              testIdPrefix="session-auto-approve"
            />
          </div>
        ) : null}
      </div>
    </>
  );
}

// Agent tiles. A usable (detected + enabled) tile opens a session on click;
// unavailable ones stay dimmed and explain how to enable. This replaces the old
// dropdown + Selected-agent summary + separate submit button.
function AgentPicker({
  heading,
  subheading,
  cliDetections,
  busy,
  disabled,
  disabledHint,
  onPick,
}: {
  heading?: string;
  subheading?: string;
  cliDetections: AgentCliDetection[];
  busy: boolean;
  disabled: boolean;
  disabledHint: string;
  onPick: (kind: AgentKind) => void;
}) {
  const visible = cliDetections.filter(detection => detection.enabled);
  const usableCount = visible.filter(d => d.available).length;

  return (
    <div className={agentPickerClass}>
      {heading ? (
        <div className={agentPickerHeaderClass}>
          <Typography
            as="span"
            variant="caption"
            tone="faint"
            uppercase
            style={{ letterSpacing: '0.08em' }}
          >
            {heading}
          </Typography>
          {subheading ? (
            <Typography as="span" variant="caption" tone="ghost">
              {subheading}
            </Typography>
          ) : null}
        </div>
      ) : null}

      <div
        className={tileGridClass}
        data-testid="cli-choice-list"
        role="group"
        aria-label="Choose an agent"
      >
        {visible.map(detection => {
          const usable = detection.available && !disabled;
          const detectedText =
            detection.executable ?? detection.candidates[0] ?? 'Detected on PATH';
          return (
            <button
              key={detection.kind}
              type="button"
              className={agentTileClass({ available: detection.available && !disabled })}
              data-testid="cli-choice"
              data-cli-kind={detection.kind}
              data-available={detection.available ? 'true' : 'false'}
              disabled={!usable || busy}
              title={
                detection.available
                  ? `${detection.displayName} detected at ${detectedText}`
                  : `${detection.displayName} is not installed or not on PATH`
              }
              onClick={() => onPick(detection.kind)}
            >
              <AgentGlyph kind={detection.kind} />
              <Typography as="strong" variant="smallBodyAlt" tone="inherit">
                {detection.displayName}
              </Typography>
              <Typography as="small" variant="tiny" tone={detection.available ? 'good' : 'faint'}>
                {detection.available ? 'Ready' : 'Not found'}
              </Typography>
            </button>
          );
        })}
      </div>

      {disabled ? (
        <Typography as="p" variant="caption" tone="faint" className={pickerHintClass}>
          {disabledHint}
        </Typography>
      ) : usableCount === 0 ? (
        <Typography
          as="p"
          variant="caption"
          tone="faint"
          className={pickerHintClass}
          data-testid="cli-empty-help"
        >
          No supported agent CLIs are installed yet. Install Cortex, Claude Code, or Codex CLI and
          turn it on in Settings, then come back.
        </Typography>
      ) : null}
    </div>
  );
}

// A calm Off / Auto-approve segmented control, shared by the topic and session
// composers. Auto-approve reads as the warn status color when active.
function AutoApproveToggle({
  label,
  help,
  value,
  onChange,
  testIdPrefix,
}: {
  label: string;
  help: string;
  value: boolean;
  onChange: (next: boolean) => void;
  testIdPrefix: string;
}) {
  return (
    <div className={autoApproveRowClass}>
      <div className={autoApproveCopyClass}>
        <Typography as="strong" variant="smallBodyAlt" tone="default">
          {label}
        </Typography>
        <Typography as="span" variant="caption" tone="faint" style={{ lineHeight: 1.5 }}>
          {help}
        </Typography>
      </div>
      <div className={autoApproveToggleClass} role="radiogroup" aria-label={label}>
        <button
          type="button"
          role="radio"
          aria-checked={!value}
          data-active={!value}
          data-testid={`${testIdPrefix}-off`}
          onClick={() => onChange(false)}
        >
          <Typography as="span" variant="caption" tone="inherit">
            Off
          </Typography>
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={value}
          data-active={value}
          data-testid={`${testIdPrefix}-on`}
          onClick={() => onChange(true)}
        >
          <ShieldWarning size={11} />{' '}
          <Typography as="span" variant="caption" tone="inherit">
            Auto-approve
          </Typography>
        </button>
      </div>
    </div>
  );
}

const composerScrollClass = css({
  position: 'relative',
  zIndex: 2,
  height: '100%',
  minHeight: 0,
  overflowY: 'auto',
  display: 'grid',
  justifyItems: 'center',
  alignContent: 'start',
  padding: '64px 26px 48px',
});

const composerColumnClass = css({
  width: 'min(520px, 100%)',
  display: 'grid',
  justifyItems: 'stretch',
  gap: '14px',
});

const eyebrowClass = css({
  display: 'inline-flex',
  alignItems: 'center',
  gap: '8px',
});

// Hero + lead share tight spacing so they read as one unit above the input.
const heroClass = css({ margin: '2px 0 0' });
const leadClass = css({ margin: 0, maxWidth: '46ch', lineHeight: 1.6 });

const heroInputClass = css({
  marginTop: '4px',
  height: '46px',
  width: '100%',
  border: '1px solid var(--line)',
  borderRadius: '12px',
  padding: '0 14px',
  background: 'var(--surface-1)',
  color: 'var(--text)',
  fontSize: '15px',
  outline: 'none',
  transition: 'border-color 140ms ease, background 140ms ease',
  _focus: { borderColor: 'var(--line-strong)', background: 'var(--surface-2)' },
  _placeholder: { color: 'var(--text-4)' },
});

const sectionDividerClass = css({
  height: '1px',
  background: 'var(--line-faint)',
  margin: '6px 0 2px',
});

// Project drop well: the large dashed target that doubles as the picker home.
const dropWellClass = css({
  position: 'relative',
  marginTop: '4px',
  minHeight: '200px',
  display: 'grid',
  placeItems: 'center',
  borderRadius: '18px',
  border: '1.5px dashed var(--line-strong)',
  background: 'color-mix(in srgb, var(--surface-1) 60%, transparent)',
  overflow: 'hidden',
  transition: 'border-color 160ms ease, background 160ms ease',
  _hover: {
    borderColor: 'var(--text-4)',
    background: 'color-mix(in srgb, var(--surface-2) 60%, transparent)',
  },
});

const dropWellInnerClass = css({
  position: 'relative',
  zIndex: 1,
  display: 'grid',
  justifyItems: 'center',
  gap: '8px',
  padding: '24px',
  color: 'var(--text-3)',
  pointerEvents: 'auto',
  '& > button': { marginTop: '4px' },
});

const chosenFolderCardClass = css({
  marginTop: '4px',
  display: 'grid',
  gridTemplateColumns: 'auto minmax(0, 1fr) auto',
  alignItems: 'center',
  gap: '12px',
  padding: '14px 14px 14px 16px',
  borderRadius: '14px',
  border: '1px solid var(--line)',
  background: 'var(--surface-1)',
  '& > svg': { color: 'var(--text-3)' },
});

const chosenFolderTextClass = css({
  display: 'grid',
  gap: '2px',
  minWidth: 0,
});

const changeFolderButtonClass = css({
  border: '1px solid var(--line)',
  borderRadius: '999px',
  padding: '5px 11px',
  color: 'var(--text-2)',
  background: 'var(--surface-2)',
  cursor: 'pointer',
  transition: 'border-color 140ms ease, color 140ms ease',
  _hover: { color: 'var(--text)', borderColor: 'var(--line-strong)' },
});

// The project footer: Cancel pinned bottom-left, Add project bottom-right, so
// the two balance once a folder is chosen. Before that, Cancel sits alone on the
// left.
const projectFooterClass = css({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '12px',
  marginTop: '4px',
});

const dropErrorClass = css({ margin: 0, lineHeight: 1.5 });

// Agent tiles.
const agentPickerClass = css({ display: 'grid', gap: '10px' });

const agentPickerHeaderClass = css({
  display: 'flex',
  flexDirection: 'column',
  gap: '2px',
});

const tileGridClass = css({
  display: 'grid',
  gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
  gap: '10px',
  mdDown: { gridTemplateColumns: '1fr' },
});

function agentTileClass({ available }: { available: boolean }) {
  return css({
    display: 'grid',
    justifyItems: 'center',
    alignContent: 'center',
    gap: '7px',
    minHeight: '104px',
    padding: '16px 12px',
    borderRadius: '16px',
    border: '1px solid var(--line)',
    background: 'var(--surface-1)',
    color: available ? 'var(--text)' : 'var(--text-4)',
    cursor: available ? 'pointer' : 'not-allowed',
    opacity: available ? 1 : 0.55,
    boxShadow: 'var(--shadow)',
    transition: 'border-color 140ms ease, background 140ms ease, transform 140ms ease',
    _hover: available
      ? {
          borderColor: 'var(--line-strong)',
          background: 'var(--surface-2)',
          transform: 'translateY(-1px)',
        }
      : {},
    _disabled: { cursor: 'not-allowed' },
    // The AgentGlyph is small; lift it a touch in the tile.
    '& > span:first-child': { width: '22px', height: '22px' },
  });
}

const pickerHintClass = css({ margin: 0, lineHeight: 1.5 });

// Session Options disclosure.
const optionsClass = css({ marginTop: '6px', display: 'grid', gap: '10px' });

const optionsToggleClass = css({
  display: 'inline-flex',
  alignItems: 'center',
  gap: '7px',
  alignSelf: 'start',
  border: 0,
  background: 'transparent',
  padding: '4px 2px',
  cursor: 'pointer',
  color: 'var(--text-3)',
  _hover: { color: 'var(--text-2)' },
});

const optionsCaretClass = css({
  transition: 'transform 160ms ease',
  '[data-open="true"] &': { transform: 'rotate(90deg)' },
});

const optionsBodyClass = css({
  display: 'grid',
  gap: '12px',
  padding: '14px',
  borderRadius: '14px',
  border: '1px solid var(--line)',
  background: 'color-mix(in srgb, var(--surface-1) 70%, transparent)',
});

const fieldLabelClass = css({ display: 'grid', gap: '6px' });

const fieldInputClass = css({
  height: '34px',
  border: '1px solid var(--line)',
  borderRadius: '10px',
  padding: '0 10px',
  background: 'var(--surface-1)',
  color: 'var(--text)',
  outline: 'none',
  _focus: { borderColor: 'var(--line-strong)' },
});

// Auto-approve segmented control.
const autoApproveRowClass = css({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '16px',
  padding: '12px 14px',
  borderRadius: '14px',
  border: '1px solid var(--line)',
  background: 'color-mix(in srgb, var(--surface-1) 70%, transparent)',
});

const autoApproveCopyClass = css({
  display: 'grid',
  gap: '2px',
  minWidth: 0,
});

const autoApproveToggleClass = css({
  display: 'inline-flex',
  gap: '6px',
  flexShrink: 0,
  padding: '3px',
  border: '1px solid var(--line)',
  borderRadius: '999px',
  background: 'color-mix(in srgb, var(--surface-2) 75%, transparent)',
  '& button': {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '5px',
    padding: '4px 11px',
    borderRadius: '999px',
    border: 0,
    background: 'transparent',
    color: 'var(--text-3)',
    cursor: 'pointer',
    transition: 'background 140ms ease, color 140ms ease',
  },
  '& button[data-active="true"]': {
    background: 'var(--surface-hi)',
    color: 'var(--text)',
  },
  '& button:hover': { color: 'var(--text)' },
  '& button[data-testid$="-on"][data-active="true"]': {
    background: 'color-mix(in srgb, var(--warn) 18%, var(--surface-hi) 82%)',
    color: 'var(--warn)',
  },
});

const cancelLinkClass = css({
  // Centered when it stands alone (topic/session); the project footer overrides
  // placement via flex space-between. No marginTop so it sits flush with the
  // Add project button in that footer row.
  justifySelf: 'center',
  border: 0,
  background: 'transparent',
  cursor: 'pointer',
  padding: '4px 8px',
  borderRadius: '8px',
  _hover: { background: 'var(--surface-1)' },
});
