import { ShieldWarning } from '@phosphor-icons/react';
import { css } from '../../styled-system/css';
import { agentLabel, sessionBreadcrumb, shortenCwd } from '../../domain';
import type {
  ActivityPermissionRequest,
  SessionTerminalBinding,
  ShellSession,
  WorkspaceShellSnapshot,
} from '../../domain';
import type { TerminalSession } from '../../hooks';
import { Typography } from '../primitives/Typography';
import { SessionLaunchOverlay } from './SessionLaunchOverlay';
import { TerminalContextMenu } from './TerminalContextMenu';

// The slice of the terminal session handle this surface binds: the DOM refs and
// the input/scroll handlers. The shell passes the whole handle; structural
// typing narrows it here so the hook stays the single owner of the island.
type TerminalSurfaceHandle = Pick<
  TerminalSession,
  | 'canvasRef'
  | 'surfaceViewportRef'
  | 'terminalScrollSpacerRef'
  | 'handleTerminalScroll'
  | 'handleTerminalWheel'
  | 'focusTerminalCanvas'
  | 'handleTerminalKeyDown'
  | 'handleTerminalPaste'
  | 'followLiveTerminalOutput'
  | 'contextMenu'
  | 'closeContextMenu'
>;

export interface TerminalSurfaceProps {
  session: ShellSession;
  shell: WorkspaceShellSnapshot;
  terminalBinding: SessionTerminalBinding | null;
  runningLabel: string;
  terminalLiveFollow: boolean;
  scrollbackRowCount: number;
  scrollbackMaxRows: number;
  permissionRequest: ActivityPermissionRequest | null;
  launching: boolean;
  busy: boolean;
  terminal: TerminalSurfaceHandle;
  onLaunch: () => void;
}

// The terminal viewport and its chrome: the meta strip, the optional permission
// banner, the imperative Canvas island, and the launch overlay when no live
// terminal is attached yet. The Canvas is owned by the terminal hook, not React.
export function TerminalSurface({
  session,
  shell,
  terminalBinding,
  runningLabel,
  terminalLiveFollow,
  scrollbackRowCount,
  scrollbackMaxRows,
  permissionRequest,
  launching,
  busy,
  terminal,
  onLaunch,
}: TerminalSurfaceProps) {
  return (
    <div
      className={terminalBodyClass}
      data-testid="terminal-body"
      data-session-id={session.id}
      data-terminal-id={terminalBinding?.terminalId ?? ''}
    >
      <div
        className={terminalMetaStripClass}
        data-testid="terminal-meta-strip"
        data-session-id={session.id}
        data-terminal-id={terminalBinding?.terminalId ?? ''}
      >
        <Typography as="span" variant="caption" tone="muted" className={metaStripBreadcrumbClass}>
          {sessionBreadcrumb(session, shell)} · {session.title}
        </Typography>
        <Typography
          as="span"
          variant="tiny"
          tone="faint"
          uppercase
          data-testid="terminal-status-label"
          className={metaStripStatusClass}
          style={{ letterSpacing: '0.08em' }}
        >
          {runningLabel}
        </Typography>
        <Typography
          as="span"
          variant="tiny"
          tone="faint"
          className={metaStripCwdClass}
          title={session.cwd}
          style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace' }}
        >
          {shortenCwd(session.cwd)}
        </Typography>
        {!terminalLiveFollow ? (
          <button
            type="button"
            className={followLiveButtonClass}
            data-testid="follow-live-button"
            onClick={terminal.followLiveTerminalOutput}
          >
            <Typography as="span" variant="tiny" tone="inherit">
              Jump to latest
            </Typography>
          </button>
        ) : null}
        <Typography
          as="span"
          variant="caption"
          tone="faint"
          data-testid="scrollback-row-count"
          hidden
        >
          {scrollbackRowCount.toLocaleString()} / {scrollbackMaxRows.toLocaleString()}
        </Typography>
        <Typography as="span" variant="caption" tone="faint" data-testid="follow-live-state" hidden>
          {terminalLiveFollow ? 'live' : 'history'}
        </Typography>
      </div>
      {permissionRequest ? (
        <div
          className={permissionBannerClass}
          data-testid="session-permission-banner"
          role="status"
        >
          <ShieldWarning size={14} weight="fill" />
          <div className={permissionBannerBodyClass}>
            <Typography as="strong" variant="caption" tone="default">
              {agentLabel(session.agentKind)} wants to {permissionRequest.toolName}
            </Typography>
            <Typography
              as="span"
              variant="caption"
              tone="muted"
              data-testid="session-permission-banner-summary"
              className={permissionBannerSummaryClass}
              style={{
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
              }}
            >
              {permissionRequest.displaySummary}
            </Typography>
          </div>
          <Typography
            as="span"
            variant="tiny"
            tone="warn"
            uppercase
            className={permissionBannerHintClass}
            style={{ letterSpacing: '0.08em' }}
          >
            Respond in the terminal
          </Typography>
        </div>
      ) : null}
      <div
        ref={terminal.surfaceViewportRef}
        className={surfaceViewportClass}
        data-testid="terminal-viewport"
        onScroll={terminal.handleTerminalScroll}
        onWheel={terminal.handleTerminalWheel}
        onMouseDown={terminal.focusTerminalCanvas}
      >
        <div
          ref={terminal.terminalScrollSpacerRef}
          className={terminalScrollSpacerClass}
          data-testid="terminal-scroll-spacer"
        >
          <canvas
            ref={terminal.canvasRef}
            className="terminal-canvas"
            data-testid="terminal-canvas"
            aria-label="Terminal runtime surface"
            tabIndex={0}
            onKeyDown={terminal.handleTerminalKeyDown}
            onPaste={terminal.handleTerminalPaste}
            onMouseDown={terminal.focusTerminalCanvas}
          />
        </div>
        {!terminalBinding ? (
          <SessionLaunchOverlay
            session={session}
            launching={launching}
            disabled={busy && !launching}
            onLaunch={onLaunch}
          />
        ) : null}
      </div>
      <TerminalContextMenu model={terminal.contextMenu} onClose={terminal.closeContextMenu} />
    </div>
  );
}

const terminalBodyClass = css({
  position: 'relative',
  flex: 1,
  minHeight: 0,
  display: 'grid',
  // meta strip | optional permission banner | viewport
  gridTemplateRows: 'auto auto minmax(0, 1fr)',
  overflow: 'hidden',
  borderRadius: '0 0 22px 22px',
  background: 'transparent',
  boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.025)',
});

const permissionBannerClass = css({
  display: 'flex',
  alignItems: 'center',
  gap: '10px',
  padding: '8px 14px',
  background: 'color-mix(in srgb, var(--warn) 12%, transparent)',
  borderBottom: '1px solid color-mix(in srgb, var(--warn) 28%, transparent)',
  '& > svg': { color: 'var(--warn)', flexShrink: 0 },
});

const permissionBannerBodyClass = css({
  display: 'flex',
  flexDirection: 'column',
  gap: '2px',
  minWidth: 0,
  flex: 1,
});

const permissionBannerSummaryClass = css({
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
});

const permissionBannerHintClass = css({
  flexShrink: 0,
});

const terminalMetaStripClass = css({
  display: 'flex',
  alignItems: 'center',
  gap: '12px',
  padding: '8px 14px',
  borderBottom: '1px solid color-mix(in srgb, var(--line) 60%, transparent)',
  whiteSpace: 'nowrap',
  overflowX: 'auto',
  '& [hidden]': { display: 'none' },
});

const metaStripBreadcrumbClass = css({
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  minWidth: 0,
  flex: '0 1 auto',
});

const metaStripStatusClass = css({
  flexShrink: 0,
});

const metaStripCwdClass = css({
  marginLeft: 'auto',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
});

const followLiveButtonClass = css({
  color: 'var(--text-2)',
  border: '1px solid var(--line)',
  background: 'transparent',
  borderRadius: '999px',
  padding: '3px 9px',
  cursor: 'pointer',
  flexShrink: 0,
  transition: 'color 140ms ease, border-color 140ms ease',
  _hover: { color: 'var(--text)', borderColor: 'var(--line-strong)' },
});

const surfaceViewportClass = css({
  position: 'relative',
  minHeight: 0,
  height: '100%',
  overflow: 'auto',
  background: 'transparent',
});

const terminalScrollSpacerClass = css({
  position: 'relative',
  minHeight: '100%',
  overflow: 'hidden',
});
