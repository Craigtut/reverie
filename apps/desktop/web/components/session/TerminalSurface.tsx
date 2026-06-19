import { ArrowDown, ShieldWarning } from '@phosphor-icons/react';
import { AnimatePresence } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { css } from '../../styled-system/css';
import { agentLabel, isResumeLaunch } from '../../domain';
import { useUiStore } from '../../store';
import type { ActivityPermissionRequest, SessionTerminalBinding, ShellSession } from '../../domain';
import type { TerminalSession } from '../../hooks';
import { Typography } from '../primitives/Typography';
import { SessionIdleLaunchCard, SessionResumeOverlay } from './SessionLaunchOverlay';
import { TerminalContextMenu } from './TerminalContextMenu';
import { TerminalScrollbar } from './TerminalScrollbar';

// Minimum time the resume/start overlay stays up once shown, so a session that
// wakes almost instantly does not flicker the loading visuals in and out.
const MIN_RESUME_DWELL_MS = 1000;

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
  | 'handleTerminalKeyUp'
  | 'handleTerminalCompositionStart'
  | 'handleTerminalCompositionEnd'
  | 'handleTerminalTextInput'
  | 'handleTerminalPaste'
  | 'followLiveTerminalOutput'
  | 'contextMenu'
  | 'closeContextMenu'
  | 'scrollbar'
>;

export interface TerminalSurfaceProps {
  session: ShellSession;
  terminalBinding: SessionTerminalBinding | null;
  terminalContentReady: boolean;
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
  terminalContentReady,
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
  const waitingForTerminalContent = Boolean(terminalBinding && !terminalContentReady);
  const showLaunchOverlay = !terminalBinding || waitingForTerminalContent;
  const launchOverlayLaunching = launching || waitingForTerminalContent;

  // The resume "coming back to life" overlay is presence-driven: <AnimatePresence>
  // owns the fade-out + unmount, so there is no hand-rolled phase machine or exit
  // timer to get stranded. `oweResume` latches that the selected session owes a
  // resume moment the first time it is seen waking (so a session that wakes while
  // the boot still covers the screen still gets its moment afterward); `dwellDone`
  // marks the minimum on-screen time, so an instant wake still reads as a moment.
  const bootSequenceActive = useUiStore(s => s.bootSequenceActive);
  const waking = showLaunchOverlay && launchOverlayLaunching;
  const [oweResume, setOweResume] = useState(false);
  const [dwellDone, setDwellDone] = useState(false);
  // Freeze resume-vs-start at the instant the wake begins: Claude gains its native
  // session ref mid-launch, which would otherwise flip "Starting" to "Resuming".
  const resumingRef = useRef(false);
  const prevSessionIdRef = useRef(session.id);

  // A session switch starts fresh: drop any owed resume so a stale latch never
  // shows the wrong session's moment.
  useEffect(() => {
    if (prevSessionIdRef.current === session.id) return;
    prevSessionIdRef.current = session.id;
    setOweResume(false);
    setDwellDone(false);
  }, [session.id]);

  // Latch the owed resume (and freeze the verb) the first time this session wakes.
  useEffect(() => {
    if (waking && !oweResume) {
      resumingRef.current = isResumeLaunch(session);
      setOweResume(true);
    }
  }, [waking, oweResume, session]);

  // Retire the owed resume once the session is ready (not waking) AND the minimum
  // dwell has elapsed. Clearing `oweResume` drops the overlay, which
  // AnimatePresence then fades out over the now-live terminal.
  useEffect(() => {
    if (oweResume && dwellDone && !waking) {
      setOweResume(false);
      setDwellDone(false);
    }
  }, [oweResume, dwellDone, waking]);

  // Present while a resume is owed and the boot is not covering the screen (the
  // power-on plays first; the two never stack).
  const resumePresent = oweResume && !bootSequenceActive;

  // `resumeOccupying` covers the overlay's WHOLE life on screen, including its
  // fade-out: it latches on when the overlay appears and clears only in
  // AnimatePresence's onExitComplete (below), once the overlay has fully faded
  // and unmounted. The terminal reveal gates on this, so the resume fades out
  // COMPLETELY before the terminal fades in — a sequential handoff, never a
  // cross-dissolve.
  const [resumeOccupying, setResumeOccupying] = useState(false);
  useEffect(() => {
    if (resumePresent) setResumeOccupying(true);
  }, [resumePresent]);
  // Safety net: AnimatePresence's onExitComplete is the primary release, but if it
  // ever fails to fire the terminal must not stay hidden. Once the overlay is
  // exiting (occupying but no longer present), force-release a beat after the
  // fade-out should have finished.
  useEffect(() => {
    if (!resumeOccupying || resumePresent) return;
    const id = window.setTimeout(() => setResumeOccupying(false), 900);
    return () => window.clearTimeout(id);
  }, [resumeOccupying, resumePresent]);

  // Run the minimum-dwell timer once, the moment the overlay first appears.
  useEffect(() => {
    if (!resumePresent) return;
    const id = window.setTimeout(() => setDwellDone(true), MIN_RESUME_DWELL_MS);
    return () => window.clearTimeout(id);
  }, [resumePresent]);

  // The idle launch card shows only when nothing is waking/owed and the boot is
  // not covering the screen.
  const showIdleCard =
    showLaunchOverlay && !launchOverlayLaunching && !resumePresent && !bootSequenceActive;

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
                selectable
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
            // The terminal stays hidden until the resume overlay has FULLY faded
            // out and unmounted (resumeOccupying), then fades in — a sequential
            // handoff, never a cross-dissolve with the still-fading loader.
            data-content-ready={
              terminalBinding && terminalContentReady && !resumeOccupying ? 'true' : 'false'
            }
            data-testid="terminal-scroll-spacer"
          >
            <canvas
              ref={terminal.canvasRef}
              className="terminal-canvas"
              data-testid="terminal-canvas"
              aria-label="Terminal runtime surface"
              tabIndex={-1}
              onKeyDown={terminal.handleTerminalKeyDown}
              onKeyUp={terminal.handleTerminalKeyUp}
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
              onKeyUp={terminal.handleTerminalKeyUp}
              onCompositionStart={terminal.handleTerminalCompositionStart}
              onCompositionEnd={terminal.handleTerminalCompositionEnd}
              onInput={terminal.handleTerminalTextInput}
              onPaste={terminal.handleTerminalPaste}
            />
          </div>
          {/* AnimatePresence owns the resume overlay's fade-out + unmount, so the
            handoff to the live terminal needs no exit timer. onExitComplete fires
            once the fade-out fully finishes, releasing the terminal to fade in. */}
          <AnimatePresence onExitComplete={() => setResumeOccupying(false)}>
            {resumePresent ? (
              <SessionResumeOverlay
                key={session.id}
                session={session}
                resuming={resumingRef.current}
              />
            ) : null}
          </AnimatePresence>
          {showIdleCard ? (
            <SessionIdleLaunchCard
              session={session}
              disabled={Boolean(terminalBinding) || (busy && !launchOverlayLaunching)}
              onLaunch={onLaunch}
            />
          ) : null}
        </div>
        {/* Edge fades. The viewport runs edge to edge; these sit over its top and
          bottom in the terminal body (which does not scroll), so content dips
          under them as it scrolls. The top fade lives under the floating tab
          band and hides scrolled-back rows showing through the gaps between the
          pills; the bottom fade lets the live tail trail off the bottom edge.
          Both fade from the terminal background, so the blend is seamless, and
          are click-through. */}
        <div className={topFadeClass} aria-hidden="true" />
        <div className={bottomFadeClass} aria-hidden="true" />
        {/* Floating "jump to latest": only present once the user has scrolled up
          off the live tail. Anchored to the panel's bottom-right, it drops them
          back to the newest output. */}
        {!terminalLiveFollow ? (
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
  '& .terminal-canvas': {
    // Calm fade-in as it reveals, so the handoff from the resume overlay reads
    // as a deliberate transition rather than a cut.
    transition: 'opacity 340ms ease',
  },
  '&[data-content-ready="false"] .terminal-canvas': {
    opacity: 0,
  },
  '&[data-content-ready="true"] .terminal-canvas': {
    opacity: 1,
  },
});

// Top edge fade: content fills right up to the top and gently dissolves into the
// terminal background under the floating tab band, instead of butting the chrome
// or leaving a slab of dead space. A soft top-to-bottom fade (opaque only at the
// very top edge so scrolled-back rows disappear cleanly, then a quick fade to
// transparent) covers roughly the tab-band height, so the floating tabs sit over
// a softened area rather than raw text. The fade runs ~24px past the bottom of
// the floating tab band so content dissolves gradually below the tabs rather than
// snapping in right at their edge. zIndex 3 keeps it above the canvas (in the
// scrolling viewport) and below the tabs (zIndex 5) and jump button (4).
const topFadeClass = css({
  position: 'absolute',
  top: 0,
  left: 0,
  right: 0,
  height: '84px',
  zIndex: 3,
  pointerEvents: 'none',
  background: 'linear-gradient(to bottom, var(--terminal-bg) 0%, transparent 100%)',
});

// Bottom edge fade: lifts the live tail off the bottom edge and lets the last
// rows trail off gradually rather than butting it. Taller than the bottom inset
// so the dissolve spans a couple of rows.
const bottomFadeClass = css({
  position: 'absolute',
  bottom: 0,
  left: 0,
  right: 0,
  height: '56px',
  zIndex: 3,
  pointerEvents: 'none',
  background: 'linear-gradient(to top, var(--terminal-bg) 0%, transparent 100%)',
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
