import { CaretRight, Moon, Sun } from '@phosphor-icons/react';

import { css } from '../../styled-system/css';
import type { CreateSessionRecordRequest } from '../../domain';
import { useUiStore } from '../../store';

// The settings surface: appearance (theme) + default new-session preferences.
// Theme is read straight from the UI store; the new-session prefs are shared
// App state (also used by the creation composer) and arrive as props.
export function SettingsSurface({
  newSessionAgentKind,
  setNewSessionAgentKind,
  newSessionDangerousMode,
  setNewSessionDangerousMode,
}: {
  newSessionAgentKind: CreateSessionRecordRequest['agentKind'];
  setNewSessionAgentKind: (value: CreateSessionRecordRequest['agentKind']) => void;
  newSessionDangerousMode: boolean;
  setNewSessionDangerousMode: (value: boolean) => void;
}) {
  const theme = useUiStore(s => s.theme);
  const setTheme = useUiStore(s => s.setTheme);

  return (
    <div className={settingsSurfaceClass} data-testid="settings-surface">
      <div className={settingsScrollClass}>
        <header className={settingsHeaderClass}>
          <span className={settingsKickerClass}>Settings</span>
          <h1 className={settingsTitleClass}>Settings</h1>
        </header>

        <section className={settingsGroupClass} aria-labelledby="settings-appearance-label">
          <h2 id="settings-appearance-label" className={settingsGroupLabelClass}>Appearance</h2>
          <ul className={settingsListClass}>
            <li className={settingsRowClass}>
              <div className={settingsRowTextClass}>
                <span className={settingsRowTitleClass}>Theme</span>
                <span className={settingsRowHelpClass}>The same warm-neutral palette in either mode.</span>
              </div>
              <div className={themeSegmentedClass} role="radiogroup" aria-label="Theme">
                <button
                  type="button"
                  role="radio"
                  aria-checked={theme === 'light'}
                  aria-label="Light theme"
                  data-active={theme === 'light'}
                  data-testid="settings-theme-light"
                  onClick={() => setTheme('light')}
                >
                  <Sun size={15} />
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={theme === 'dark'}
                  aria-label="Dark theme"
                  data-active={theme === 'dark'}
                  data-testid="settings-theme-dark"
                  onClick={() => setTheme('dark')}
                >
                  <Moon size={15} />
                </button>
              </div>
            </li>
          </ul>
        </section>

        <section className={settingsGroupClass} aria-labelledby="settings-sessions-label">
          <h2 id="settings-sessions-label" className={settingsGroupLabelClass}>Sessions</h2>
          <ul className={settingsListClass}>
            <li className={settingsRowClass}>
              <div className={settingsRowTextClass}>
                <span className={settingsRowTitleClass}>Default agent</span>
                <span className={settingsRowHelpClass}>The CLI new sessions start with.</span>
              </div>
              <div className={settingsSelectWrapClass}>
                <select
                  className={settingsSelectClass}
                  value={newSessionAgentKind}
                  data-testid="settings-default-agent"
                  onChange={event => setNewSessionAgentKind(event.currentTarget.value as CreateSessionRecordRequest['agentKind'])}
                >
                  <option value="cortex_code">Cortex Code</option>
                  <option value="codex_cli">Codex CLI</option>
                  <option value="claude_code">Claude Code</option>
                </select>
                <CaretRight size={12} weight="bold" />
              </div>
            </li>
            <li className={settingsRowClass}>
              <div className={settingsRowTextClass}>
                <span className={settingsRowTitleClass}>Enable YOLO for new sessions</span>
                <span className={settingsRowHelpClass}>Skip per-tool approvals when launching a new session.</span>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={newSessionDangerousMode}
                aria-label="Enable YOLO for new sessions"
                data-state={newSessionDangerousMode ? 'on' : 'off'}
                data-testid="settings-yolo-toggle"
                className={settingsSwitchClass}
                onClick={() => setNewSessionDangerousMode(!newSessionDangerousMode)}
              >
                <span className={settingsSwitchKnobClass} />
              </button>
            </li>
          </ul>
        </section>
      </div>
    </div>
  );
}

const settingsSurfaceClass = css({
  position: 'relative',
  zIndex: 2,
  height: '100%',
  minHeight: 0,
  overflow: 'auto',
  background: 'transparent',
});

const settingsScrollClass = css({
  width: 'min(680px, calc(100% - 64px))',
  margin: '0 auto',
  padding: '72px 0 96px',
  display: 'grid',
  gap: '36px',
  lgDown: { width: 'min(680px, calc(100% - 40px))', padding: '48px 0 72px' },
});

const settingsHeaderClass = css({
  display: 'grid',
  gap: '6px',
  marginBottom: '4px',
});

const settingsKickerClass = css({
  color: 'var(--text-3)',
  fontSize: '11px',
  letterSpacing: '0.12em',
  textTransform: 'uppercase',
});

const settingsTitleClass = css({
  margin: 0,
  fontSize: '32px',
  letterSpacing: '-0.035em',
  color: 'var(--text)',
  fontWeight: 500,
});

const settingsGroupClass = css({
  display: 'grid',
  gap: '12px',
});

const settingsGroupLabelClass = css({
  margin: 0,
  color: 'var(--text-3)',
  fontSize: '10.5px',
  letterSpacing: '0.12em',
  textTransform: 'uppercase',
  fontWeight: 500,
});

const settingsListClass = css({
  listStyle: 'none',
  margin: 0,
  padding: 0,
  display: 'grid',
  borderTop: '1px solid var(--line-faint)',
  borderBottom: '1px solid var(--line-faint)',
});

const settingsRowClass = css({
  display: 'flex',
  alignItems: 'center',
  gap: '24px',
  padding: '18px 4px',
  borderTop: '1px solid var(--line-faint)',
  _first: { borderTop: 'none' },
});

const settingsRowTextClass = css({
  flex: 1,
  minWidth: 0,
  display: 'grid',
  gap: '3px',
});

const settingsRowTitleClass = css({
  color: 'var(--text)',
  fontSize: '13.5px',
  fontWeight: 500,
  letterSpacing: '-0.005em',
});

const settingsRowHelpClass = css({
  color: 'var(--text-3)',
  fontSize: '12px',
  lineHeight: 1.5,
});

const themeSegmentedClass = css({
  display: 'inline-flex',
  padding: '3px',
  borderRadius: '999px',
  border: '1px solid var(--line)',
  background: 'color-mix(in srgb, var(--surface-1) 80%, transparent)',
  gap: '2px',
  '& button': {
    width: '34px',
    height: '28px',
    display: 'grid',
    placeItems: 'center',
    borderRadius: '999px',
    color: 'var(--text-3)',
    cursor: 'pointer',
    transition: 'color 140ms ease, background 140ms ease',
    _hover: { color: 'var(--text-2)' },
  },
  '& button[data-active="true"]': {
    color: 'var(--text)',
    background: 'var(--surface-3)',
    boxShadow: 'inset 0 0 0 1px var(--line-strong)',
  },
});

const settingsSelectWrapClass = css({
  position: 'relative',
  display: 'inline-flex',
  alignItems: 'center',
  '& svg': {
    position: 'absolute',
    right: '10px',
    color: 'var(--text-3)',
    pointerEvents: 'none',
    transform: 'rotate(90deg)',
  },
});

const settingsSelectClass = css({
  appearance: 'none',
  border: '1px solid var(--line)',
  borderRadius: '10px',
  background: 'color-mix(in srgb, var(--surface-1) 80%, transparent)',
  color: 'var(--text)',
  font: 'inherit',
  fontSize: '13px',
  padding: '8px 28px 8px 12px',
  cursor: 'pointer',
  outline: 'none',
  transition: 'border-color 140ms ease, background 140ms ease',
  _hover: { borderColor: 'var(--line-strong)' },
  _focusVisible: { borderColor: 'var(--line-strong)', boxShadow: '0 0 0 3px color-mix(in srgb, var(--text) 8%, transparent)' },
});

const settingsSwitchClass = css({
  position: 'relative',
  width: '38px',
  height: '22px',
  borderRadius: '999px',
  border: '1px solid var(--line)',
  background: 'var(--surface-2)',
  cursor: 'pointer',
  padding: 0,
  flexShrink: 0,
  transition: 'background 160ms ease, border-color 160ms ease',
  _hover: { borderColor: 'var(--line-strong)' },
  '&[data-state="on"]': {
    background: 'color-mix(in srgb, var(--warn) 78%, transparent)',
    borderColor: 'color-mix(in srgb, var(--warn) 60%, var(--line-strong))',
  },
});

const settingsSwitchKnobClass = css({
  position: 'absolute',
  top: '50%',
  left: '2px',
  width: '16px',
  height: '16px',
  borderRadius: '50%',
  background: 'var(--text)',
  transform: 'translateY(-50%)',
  transition: 'left 160ms ease, background 160ms ease',
  boxShadow: '0 1px 2px rgba(0,0,0,0.25)',
  '[data-state="on"] &': {
    left: '18px',
    background: '#FFFFFF',
  },
});
