import { motion } from 'motion/react';
import { GearSix, Plus, ShieldWarning, Sparkle, TerminalWindow } from '@phosphor-icons/react';

import { css } from '../../styled-system/css';
import { DotMatrixWord } from '../brand';
import { Typography } from '../primitives/Typography';

// First-run panel, shown only when the workspace has no sessions yet. It keeps
// the few things that belong here: a way to start a session in General, create
// a project, open settings, and set the auto-approve default. No per-step boxes
// and no CLI roster (session creation surfaces the real CLI choices).
export function EmptyState({
  createProject,
  createGeneralSession,
  openSettings,
  workspaceDefaultDangerousMode,
  onSetWorkspaceDefaultDangerousMode,
}: {
  createProject: () => void;
  createGeneralSession: () => void;
  openSettings: () => void;
  workspaceDefaultDangerousMode: boolean;
  onSetWorkspaceDefaultDangerousMode: (next: boolean) => void;
}) {
  return (
    <div className={emptyStateClass} data-testid="onboarding-panel">
      <motion.div
        className={emptyCenterClass}
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.28 }}
      >
        <Typography
          as="span"
          variant="caption"
          tone="faint"
          uppercase
          className={kickerClass}
          style={{ letterSpacing: '0.08em' }}
        >
          <TerminalWindow size={14} /> Agent Orchestrator
        </Typography>
        <DotMatrixWord />
        <Typography
          as="p"
          variant="smallBody"
          tone="inherit"
          align="center"
          className={proseClass}
          style={{ lineHeight: 1.7 }}
        >
          A home for your terminal agent sessions, kept organized and ready to resume. Start a
          general session to begin, or add a folder to create a project to work in.
        </Typography>

        <div className={actionsClass}>
          <button
            type="button"
            className="primary"
            data-testid="empty-create-session-button"
            onClick={createGeneralSession}
          >
            <Plus size={14} />{' '}
            <Typography as="span" variant="smallBody" tone="inherit">
              New session
            </Typography>
          </button>
          <button type="button" data-testid="empty-create-project-button" onClick={createProject}>
            <Plus size={14} />{' '}
            <Typography as="span" variant="smallBody" tone="inherit">
              Create project
            </Typography>
          </button>
          <button type="button" data-testid="empty-settings-button" onClick={openSettings}>
            <GearSix size={14} />{' '}
            <Typography as="span" variant="smallBody" tone="inherit">
              Settings
            </Typography>
          </button>
        </div>

        <div className={safetyCardClass} data-testid="onboarding-safety-step">
          <div className={safetyCopyClass}>
            <Typography as="strong" variant="smallBodyAlt" tone="default">
              <Sparkle size={12} weight="fill" /> Auto-approve default
            </Typography>
            <Typography as="span" variant="caption" tone="faint" style={{ lineHeight: 1.55 }}>
              Off by default. New sessions launch with full prompts unless you choose otherwise.
              Override per session anytime.
            </Typography>
          </div>
          <div className={safetyToggleClass} role="radiogroup" aria-label="Auto-approve default">
            <button
              type="button"
              role="radio"
              aria-checked={!workspaceDefaultDangerousMode}
              data-active={!workspaceDefaultDangerousMode}
              data-testid="onboarding-safety-off"
              onClick={() => onSetWorkspaceDefaultDangerousMode(false)}
            >
              <Typography as="span" variant="caption" tone="inherit">
                Off
              </Typography>
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={workspaceDefaultDangerousMode}
              data-active={workspaceDefaultDangerousMode}
              data-testid="onboarding-safety-on"
              onClick={() => onSetWorkspaceDefaultDangerousMode(true)}
            >
              <ShieldWarning size={11} />{' '}
              <Typography as="span" variant="caption" tone="inherit">
                Auto-approve
              </Typography>
            </button>
          </div>
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
  background: 'transparent',
});

const emptyCenterClass = css({
  position: 'relative',
  zIndex: 1,
  display: 'grid',
  justifyItems: 'center',
  gap: '18px',
  width: 'min(440px, calc(100vw - 360px))',
  color: 'var(--text-2)',
  '& p': { margin: 0 },
});

const kickerClass = css({
  display: 'inline-flex',
  alignItems: 'center',
  gap: '8px',
});

const proseClass = css({
  maxWidth: '420px',
});

const actionsClass = css({
  display: 'flex',
  gap: '10px',
  flexWrap: 'wrap',
  justifyContent: 'center',
  '& button': {
    height: '34px',
    display: 'inline-flex',
    alignItems: 'center',
    gap: '7px',
    padding: '0 14px',
    borderRadius: '999px',
    border: '1px solid var(--line)',
    color: 'var(--text-2)',
    background: 'var(--surface-1)',
    boxShadow: 'var(--shadow)',
    cursor: 'pointer',
    transition: 'background 140ms ease, color 140ms ease, border-color 140ms ease',
    _hover: { color: 'var(--text)', background: 'var(--surface-2)' },
  },
  '& button.primary': {
    borderColor: 'var(--line-strong)',
    background: 'var(--surface-3)',
    color: 'var(--text)',
    _hover: { background: 'var(--surface-hi)' },
  },
});

const safetyCardClass = css({
  width: '100%',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '16px',
  marginTop: '4px',
  padding: '14px 16px',
  borderRadius: '16px',
  border: '1px solid var(--line)',
  background: 'color-mix(in srgb, var(--surface-1) 80%, transparent)',
  textAlign: 'left',
});

const safetyCopyClass = css({
  display: 'grid',
  gap: '3px',
  minWidth: 0,
  '& strong': { display: 'inline-flex', alignItems: 'center', gap: '6px' },
});

const safetyToggleClass = css({
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
  '& button[data-testid="onboarding-safety-on"][data-active="true"]': {
    background: 'color-mix(in srgb, var(--warn) 18%, var(--surface-hi) 82%)',
    color: 'var(--warn)',
  },
});
