import { ArrowDown, ShieldWarning } from '@phosphor-icons/react';
import { css } from '../../styled-system/css';
import { agentLabel } from '../../domain';
import type { ActivityPermissionRequest, SessionTerminalBinding, ShellSession } from '../../domain';
import type { TerminalSession } from '../../hooks';
import { Typography } from '../primitives/Typography';
import { SessionLaunchOverlay } from './SessionLaunchOverlay';
import { TerminalContextMenu } from './TerminalContextMenu';
import { TerminalScrollbar } from './TerminalScrollbar';

// The slice of the terminal session handle this surface binds: the DOM refs and
// the input/scroll handlers. The shell passes the whole handle; structural
// typing narrows it here so the hook stays the single owner of the island.
type TerminalSurfaceHandle = Pick<
  TerminalSession,
  | 'canvasRef'
  | 'terminalTextInputRef'
  | 'attachViewport'
  | 'terminalScrollSpacerRef'
  | 'handleTerminalScroll'
  | 'focusTerminalCanvas'
  | 'handleTerminalKeyDown'
  | 'handleTerminalCompositionStart'
  | 'handleTerminalCompositionEnd'
  | 'handleTerminalTextInput'
  | 'handleTerminalPaste'
  | 'followLiveTerminalOutput'
  | 'contextMenu'
  | 'closeContextMenu'
  | 'historyViewing'
  | 'viewFullHistory'
  | 'scrollbar'
>;

export interface TerminalSurfaceProps {
  session: ShellSession;
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

// The terminal viewport and its chrome: the optional permission banner, the
// imperative Canvas island, and the launch overlay when no live terminal is
// attached yet. The custom scrollbar lives in its own gutter to the RIGHT of the
// terminal panel (not overlaying the content). Session identity and the terminal
// view actions live in the tabs bar above. The Canvas is owned by the hook.
export function TerminalSurface({
  session,
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
    <div className={terminalRowClass}>
      <div
        className={terminalBodyClass}
        data-testid="terminal-body"
        data-session-id={session.id}
        data-terminal-id={terminalBinding?.terminalId ?? ''}
      >
        {/* Hidden diagnostics: the visible meta strip was removed, but these keep
          the harness-observable signals (running status, scroll position) in the
          DOM without any chrome. */}
        <div hidden className={diagnosticsClass}>
          <span data-testid="terminal-status-label">{runningLabel}</span>
          <span data-testid="scrollback-row-count">
            {scrollbackRowCount.toLocaleString()} / {scrollbackMaxRows.toLocaleString()}
          </span>
          <span data-testid="follow-live-state">{terminalLiveFollow ? 'live' : 'history'}</span>
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
          ref={terminal.attachViewport}
          className={surfaceViewportClass}
          data-testid="terminal-viewport"
          role="application"
          aria-label="Terminal viewport"
          onScroll={terminal.handleTerminalScroll}
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
              tabIndex={-1}
              onKeyDown={terminal.handleTerminalKeyDown}
              onPaste={terminal.handleTerminalPaste}
              onMouseDown={terminal.focusTerminalCanvas}
            />
            <textarea
              ref={terminal.terminalTextInputRef}
              className={terminalTextInputClass}
              data-testid="terminal-text-input"
              aria-label="Terminal text input"
              autoCapitalize="off"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              rows={1}
              tabIndex={0}
              onKeyDown={terminal.handleTerminalKeyDown}
              onCompositionStart={terminal.handleTerminalCompositionStart}
              onCompositionEnd={terminal.handleTerminalCompositionEnd}
              onInput={terminal.handleTerminalTextInput}
              onPaste={terminal.handleTerminalPaste}
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
        {/* Floating "jump to latest": only present once the user has scrolled up
          off the live tail (or is in the full-history view). Anchored to the
          panel's bottom-right, it drops them back to the newest output. */}
        {!terminalLiveFollow || terminal.historyViewing ? (
          <button
            type="button"
            className={jumpToLatestButtonClass}
            data-testid="follow-live-button"
            aria-label="Jump to latest output"
            title="Jump to latest"
            onClick={terminal.followLiveTerminalOutput}
          >
            <ArrowDown size={18} weight="bold" />
          </button>
        ) : null}
        <TerminalContextMenu model={terminal.contextMenu} onClose={terminal.closeContextMenu} />
      </div>
      {/* The scrollbar sits in its own gutter, outside the terminal panel. */}
      <TerminalScrollbar model={terminal.scrollbar} />
    </div>
  );
}

// Lays the terminal panel and the scrollbar gutter side by side, so the
// scrollbar reads as "just off to the right" of the terminal rather than
// overlaying its content.
const terminalRowClass = css({
  flex: 1,
  minHeight: 0,
  display: 'flex',
  flexDirection: 'row',
  alignItems: 'stretch',
  gap: '4px',
});

const terminalBodyClass = css({
  position: 'relative',
  flex: 1,
  minWidth: 0,
  minHeight: 0,
  display: 'grid',
  // optional permission banner | viewport
  gridTemplateRows: 'auto minmax(0, 1fr)',
  overflow: 'hidden',
  // Square: rounded bottom corners were clipping the ends of the last terminal row.
  borderRadius: 0,
  background: 'transparent',
});

const diagnosticsClass = css({
  position: 'absolute',
  width: '1px',
  height: '1px',
  overflow: 'hidden',
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

const surfaceViewportClass = css({
  position: 'relative',
  minHeight: 0,
  height: '100%',
  overflow: 'auto',
  // The native scrollbar is hidden; a custom scrollbar (TerminalScrollbar) sits in
  // its own gutter beside the panel and reflects position in both the live and
  // full-history views. Hiding the native one drops its inner gutter too.
  scrollbarWidth: 'none',
  '&::-webkit-scrollbar': { width: 0, height: 0 },
  background: 'var(--terminal-bg, #0B0A09)',
});

const terminalScrollSpacerClass = css({
  position: 'relative',
  minHeight: '100%',
  // Center the terminal grid within a wider viewport so the content keeps its
  // calm inset + max measure while the scroll/hover target stays edge to edge.
  margin: '0 auto',
  overflow: 'hidden',
  background: 'var(--terminal-bg, #0B0A09)',
});

const terminalTextInputClass = css({
  position: 'absolute',
  left: 0,
  top: 0,
  zIndex: 2,
  width: '1px',
  height: '1px',
  padding: 0,
  margin: 0,
  border: 0,
  outline: 0,
  resize: 'none',
  overflow: 'hidden',
  opacity: 0,
  color: 'transparent',
  background: 'transparent',
  caretColor: 'transparent',
  pointerEvents: 'none',
});

// The floating jump-to-latest affordance. Anchored to the terminal body (which is
// position: relative and does not scroll), so it stays pinned to the bottom-right
// corner while content scrolls beneath it. Monochrome + the shell's elevation
// tokens; all motion is shell-level, never in the paint loop.
const jumpToLatestButtonClass = css({
  position: 'absolute',
  right: '18px',
  bottom: '16px',
  // Above the canvas, below the context menu.
  zIndex: 4,
  width: '40px',
  height: '40px',
  display: 'grid',
  placeItems: 'center',
  borderRadius: '999px',
  color: 'var(--text-2)',
  border: '1px solid var(--line-strong)',
  // Slightly translucent + blurred so it reads as floating glass over the output,
  // not a flat sticker. The terminal panel is dark in both themes, so the dark
  // drop shadow lifts it cleanly either way.
  background: 'color-mix(in srgb, var(--surface-2) 84%, transparent)',
  backdropFilter: 'blur(10px) saturate(1.1)',
  boxShadow: '0 6px 16px rgba(0, 0, 0, 0.26), inset 0 1px 0 rgba(255, 255, 255, 0.05)',
  cursor: 'pointer',
  // Calm rise-and-settle as it appears; reduced-motion collapses it to a fade.
  animation: 'reverieJumpIn 240ms cubic-bezier(0.16, 1, 0.3, 1)',
  transition:
    'transform 180ms cubic-bezier(0.16, 1, 0.3, 1), color 160ms ease, background 160ms ease, border-color 160ms ease, box-shadow 200ms ease',
  // Hover stays in place: just a gentle swell and a brighter highlight.
  _hover: {
    color: 'var(--text)',
    background: 'var(--surface-3)',
    borderColor: 'var(--line-strong)',
    transform: 'scale(1.08)',
    boxShadow: '0 8px 20px rgba(0, 0, 0, 0.3), inset 0 1px 0 rgba(255, 255, 255, 0.07)',
  },
  _active: {
    transform: 'scale(0.96)',
    boxShadow: '0 4px 10px rgba(0, 0, 0, 0.28)',
  },
  _focusVisible: {
    outline: '2px solid var(--line-strong)',
    outlineOffset: '3px',
  },
});
