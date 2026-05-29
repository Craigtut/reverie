import { motion } from 'motion/react';
import { GearSix, Plus, ShieldWarning, TerminalWindow } from '@phosphor-icons/react';

import { css } from '../../styled-system/css';
import type { AgentCliDetection } from '../../domain';
import { DotMatrixWord } from '../brand';
import { AgentGlyph } from '../glyphs';
import { cliChoiceClass, cliChoiceGridClass } from '../primitives/cliChoice';

// First-run onboarding panel shown when the workspace has no focuses yet:
// the brand wordmark, the create-project/focus/settings actions, the
// auto-approve default toggle, and a summary of detected agent CLIs.
export function EmptyState({
  cliDetections,
  createFocus,
  createProject,
  openSettings,
  workspaceDefaultDangerousMode,
  onSetWorkspaceDefaultDangerousMode,
}: {
  cliDetections: AgentCliDetection[];
  createFocus: () => void;
  createProject: () => void;
  openSettings: () => void;
  workspaceDefaultDangerousMode: boolean;
  onSetWorkspaceDefaultDangerousMode: (next: boolean) => void;
}) {
  const availableCliCount = cliDetections.filter(detection => detection.available).length;
  const onboardingGridClass = css({
    width: 'min(860px, calc(100vw - 380px))',
    display: 'grid',
    gridTemplateColumns: '1.15fr 0.85fr',
    gap: '18px',
    alignItems: 'stretch',
    lgDown: { width: 'min(720px, calc(100vw - 340px))', gridTemplateColumns: '1fr' },
  });
  const onboardingHeroClass = css({
    display: 'grid',
    justifyItems: 'start',
    alignContent: 'center',
    gap: '16px',
    padding: '28px',
    borderRadius: '28px',
    border: '1px solid var(--line)',
    background: 'linear-gradient(135deg, color-mix(in srgb, var(--surface-2) 72%, transparent), color-mix(in srgb, var(--surface-1) 88%, transparent))',
    boxShadow: 'var(--shadow)',
    '& p': { maxWidth: '520px', lineHeight: 1.7, textAlign: 'left' },
  });
  const onboardingKickerClass = css({
    display: 'inline-flex',
    alignItems: 'center',
    gap: '8px',
    color: 'var(--text-3)',
    fontSize: '12px',
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
  });
  const onboardingStepsClass = css({
    display: 'grid',
    gap: '10px',
  });
  const onboardingStepClass = css({
    display: 'grid',
    gap: '4px',
    padding: '14px',
    borderRadius: '18px',
    border: '1px solid var(--line)',
    background: 'color-mix(in srgb, var(--surface-1) 78%, transparent)',
    textAlign: 'left',
    '& strong': { color: 'var(--text)', fontSize: '13px' },
    '& span': { color: 'var(--text-3)', fontSize: '12px', lineHeight: 1.55 },
  });
  const onboardingSafetyToggleClass = css({
    display: 'inline-flex',
    gap: '6px',
    marginTop: '8px',
    padding: '3px',
    border: '1px solid var(--line)',
    borderRadius: '999px',
    background: 'color-mix(in srgb, var(--surface-2) 75%, transparent)',
    width: 'fit-content',
    '& button': {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '5px',
      padding: '4px 11px',
      borderRadius: '999px',
      border: 0,
      background: 'transparent',
      color: 'var(--text-3)',
      fontSize: '11.5px',
      fontWeight: 500,
      cursor: 'pointer',
      transition: 'background 140ms ease, color 140ms ease',
    },
    '& button[data-active="true"]': {
      background: 'var(--surface-hi)',
      color: 'var(--text)',
    },
    '& button:hover': { color: 'var(--text)' },
    '& button[data-testid="onboarding-safety-on"][data-active="true"]': {
      background: 'color-mix(in srgb, var(--warn) 18%, var(--surface-hi) 82%)',
      color: 'var(--warn)',
    },
  });
  const onboardingCliClass = css({
    gridColumn: '1 / -1',
    display: 'grid',
    gap: '8px',
    paddingTop: '2px',
    '& > span': { color: 'var(--text-3)', fontSize: '12px', textAlign: 'left' },
  });

  return (
    <div className={emptyStateClass} data-testid="onboarding-panel">
      <motion.div className={emptyCenterClass} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.28 }}>
        <div className={onboardingGridClass}>
          <section className={onboardingHeroClass} data-testid="onboarding-hero">
            <span className={onboardingKickerClass}><TerminalWindow size={14} /> First run</span>
            <DotMatrixWord />
            <p>Start by giving Reverie one real working context. Create a project for folder-backed work, or keep it general when the agent session is not tied to a repo.</p>
            <div className={emptyActionsClass}>
              <button type="button" data-testid="empty-create-project-button" onClick={createProject}><Plus size={14} /> Create project</button>
              <button type="button" data-testid="empty-create-focus-button" onClick={createFocus}><Plus size={14} /> General focus</button>
              <button type="button" data-testid="empty-settings-button" onClick={openSettings}><GearSix size={14} /> Settings</button>
            </div>
          </section>

          <aside className={onboardingStepsClass} data-testid="onboarding-steps">
            <div className={onboardingStepClass} data-testid="onboarding-safety-step">
              <strong>Auto-approve default</strong>
              <span>Off by default. New sessions launch with full prompts unless you choose otherwise. You can override per session anytime.</span>
              <div className={onboardingSafetyToggleClass} role="radiogroup" aria-label="Auto-approve default">
                <button
                  type="button"
                  role="radio"
                  aria-checked={!workspaceDefaultDangerousMode}
                  data-active={!workspaceDefaultDangerousMode}
                  data-testid="onboarding-safety-off"
                  onClick={() => onSetWorkspaceDefaultDangerousMode(false)}
                >
                  Off
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={workspaceDefaultDangerousMode}
                  data-active={workspaceDefaultDangerousMode}
                  data-testid="onboarding-safety-on"
                  onClick={() => onSetWorkspaceDefaultDangerousMode(true)}
                >
                  <ShieldWarning size={11} /> Auto-approve
                </button>
              </div>
            </div>
            <div className={onboardingStepClass}>
              <strong>1. Project</strong>
              <span>Optional folder-backed context for long-running work.</span>
            </div>
            <div className={onboardingStepClass}>
              <strong>2. Focus</strong>
              <span>The human-sized thread inside a project or workspace.</span>
            </div>
            <div className={onboardingStepClass}>
              <strong>3. Session</strong>
              <span>Choose a detected CLI, set the cwd, then launch or resume.</span>
            </div>
            <div className={onboardingCliClass} data-testid="onboarding-cli-summary">
              <span>{availableCliCount} CLI choices available in this harness</span>
              <div className={cliChoiceGridClass}>
                {cliDetections.map(detection => (
                  <button
                    key={detection.kind}
                    type="button"
                    className={cliChoiceClass({ active: false, available: detection.available })}
                    data-testid="onboarding-cli-choice"
                    data-cli-kind={detection.kind}
                    data-available={detection.available ? 'true' : 'false'}
                    disabled
                  >
                    <AgentGlyph kind={detection.kind} />
                    <span>
                      <strong>{detection.displayName}</strong>
                      <small>{detection.available ? 'Fixture-detected' : `Missing: ${detection.candidates.join(', ')}`}</small>
                    </span>
                  </button>
                ))}
              </div>
            </div>
          </aside>
        </div>
      </motion.div>
    </div>
  );
}

const emptyStateClass = css({
  position: 'relative',
  minHeight: 0,
  height: '100%',
  display: 'grid',
  placeItems: 'center',
  overflow: 'hidden',
  background: 'radial-gradient(circle at 50% 42%, color-mix(in srgb, var(--dot-ambient) 18%, transparent), transparent 42%), var(--bg)',
  '&::before': {
    content: '""',
    position: 'absolute',
    inset: 0,
    backgroundImage: 'radial-gradient(var(--dot-bg) 1px, transparent 1px)',
    backgroundSize: '18px 18px',
    opacity: 0.8,
  },
});

const emptyCenterClass = css({
  position: 'relative',
  zIndex: 1,
  display: 'grid',
  justifyItems: 'center',
  gap: '18px',
  color: 'var(--text-2)',
  '& p': { margin: 0 },
});

const emptyActionsClass = css({
  display: 'flex',
  gap: '10px',
  '& button': {
    height: '34px',
    display: 'inline-flex',
    alignItems: 'center',
    gap: '7px',
    padding: '0 12px',
    borderRadius: '999px',
    border: '1px solid var(--line)',
    color: 'var(--text-2)',
    background: 'var(--surface-1)',
    boxShadow: 'var(--shadow)',
    cursor: 'pointer',
    _hover: { color: 'var(--text)', background: 'var(--surface-2)' },
  },
});
