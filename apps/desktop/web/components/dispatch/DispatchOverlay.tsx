import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { css } from '../../styled-system/css';
import { dispatchRootClass } from '../../themes/dispatchShell';
import { Typography } from '../primitives/Typography';
import { AgentBadge } from './AgentBadge';
import { DestinationChip } from './DestinationChip';
import {
  classifyDispatch,
  emitDispatchLaunch,
  hideDispatchWindow,
  onDispatchTrigger,
  onDispatchWindowBlur,
  saveDispatchWindowPosition,
  setDispatchWindowHeight,
} from '../../services/dispatchApi';
import { fetchWorkspaceShell, listAgentClis } from '../../services/shellApi';
import { onSpeechError } from '../../services/speechApi';
import { useSpeechCapture, useSpeechEngine } from '../../hooks';
import { useSpeechEngineStore } from '../../store';
import { provisioningLabel, voiceAvailability } from '../../domain';
import type {
  AgentCliDetection,
  AgentKind,
  DispatchRouting,
  WorkspaceShellSnapshot,
} from '../../domain';

// The dispatch capture popup. Opens over anything via the global shortcut, in
// voice mode by default: auto-listen, Stop to transcribe, then the same button
// becomes Send. Routing resolves in the background (the destination chip
// shimmers, then settles) and stays one tap to correct. On send, the resolved
// routing + prompt are handed to the main window, which creates and launches the
// session. Typed input is always available. See
// docs/product/core-experience/dispatch.md.

function deriveTitle(text: string): string {
  const snippet = text.trim().split(/\s+/).slice(0, 6).join(' ');
  return snippet || 'New task';
}

function generalRouting(text: string): DispatchRouting {
  return {
    scope: 'general',
    projectId: null,
    topicId: null,
    isNewTopic: false,
    newTopicTitle: null,
    sessionTitle: deriveTitle(text),
    confidence: null,
  };
}

export function DispatchOverlay() {
  useSpeechEngine();
  const engine = useSpeechEngineStore(state => state.engine);
  const micPermission = useSpeechEngineStore(state => state.micPermission);
  const capture = useSpeechCapture();

  const [snapshot, setSnapshot] = useState<WorkspaceShellSnapshot | null>(null);
  const [agents, setAgents] = useState<AgentCliDetection[]>([]);
  const [agentKind, setAgentKind] = useState<AgentKind>('claude_code');
  const [text, setText] = useState('');
  const [routing, setRouting] = useState<DispatchRouting | null>(null);
  const [routingPending, setRoutingPending] = useState(false);
  const [manualRouting, setManualRouting] = useState(false);
  const [agentMenuOpen, setAgentMenuOpen] = useState(false);
  const [destMenuOpen, setDestMenuOpen] = useState(false);
  // True between stopping the recording and the transcript arriving (the ASR
  // runs off-thread and takes a beat), so the UI can show it is working.
  const [transcribing, setTranscribing] = useState(false);
  // A capture/transcription failure to surface (mic denied, no device, empty
  // result), so a failed recording is never silent. Cleared on the next attempt.
  const [captureError, setCaptureError] = useState<string | null>(null);

  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const menuOpenRef = useRef(false);
  menuOpenRef.current = agentMenuOpen || destMenuOpen;
  const classifyTimer = useRef<number | null>(null);
  const classifyToken = useRef(0);
  const lastClassified = useRef('');
  // Set when text comes from a finished transcript, so routing classifies with
  // no debounce (a transcript is final; only typed edits need debouncing).
  const immediateClassifyRef = useRef(false);
  // Guards stopListening so a second trigger (or button click) can't run a
  // second stop while the first is mid-transcribe.
  const stoppingRef = useRef(false);
  // When the popup last opened. Blur within this grace window is ignored so the
  // first-capture mic-permission dialog (which steals focus right after open)
  // can't immediately dismiss the popup. Real click-aways come later.
  const openedAtRef = useRef(0);
  // Set on open when the popup should auto-record; consumed once a capture
  // starts. Lets auto-start catch up if the engine readies (or the refreshed
  // setting arrives) a moment after the window opens, instead of silently
  // skipping it because voice wasn't ready at the exact press.
  const pendingVoiceRef = useRef(false);
  const snapshotRef = useRef<WorkspaceShellSnapshot | null>(null);
  snapshotRef.current = snapshot;

  const theme = snapshot?.workspace.theme ?? 'dark';
  const generalLabel = snapshot?.workspace.generalLabel ?? 'General';
  const voiceEnabled = snapshot?.workspace.voiceEnabled !== false;
  const dispatchDefaultVoice = snapshot?.workspace.dispatchDefaultVoice !== false;
  // Collapsed availability so the disabled mic can explain itself: "still setting
  // up" vs "not available" vs "failed", instead of one opaque dimmed button.
  const availability = voiceAvailability(engine, voiceEnabled);
  const voiceReady = availability === 'ready';
  const canSend = text.trim().length > 0;

  // Keep the always-on-top transparent window honest: main.css paints an opaque
  // background on html/body/#root; clear it so only the panel shows.
  useEffect(() => {
    const targets = [document.documentElement, document.body, document.getElementById('root')];
    const previous = targets.map(element => element?.style.background ?? '');
    targets.forEach(element => {
      if (element) element.style.background = 'transparent';
    });
    return () => {
      targets.forEach((element, index) => {
        if (element) element.style.background = previous[index] ?? '';
      });
    };
  }, []);

  // Seed the snapshot (theme, default agent, projects/topics) and the agent list.
  useEffect(() => {
    let cancelled = false;
    void fetchWorkspaceShell()
      .then(loaded => {
        if (cancelled) return;
        setSnapshot(loaded);
        setAgentKind(loaded.workspace.defaultAgentKind);
      })
      .catch(() => {
        /* harness / not ready: keep defaults */
      });
    void listAgentClis()
      .then(detected => {
        if (!cancelled) setAgents(detected);
      })
      .catch(() => {
        /* keep empty; badge falls back to the default label */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Remember where the user drags the popup, so it reopens there (their "default
  // location"). Debounced; saving also re-registers the unchanged shortcut, which
  // is cheap. No-op outside the desktop runtime.
  useEffect(() => {
    const globals = window as Window & {
      __TAURI_INTERNALS__?: unknown;
      __TAURI__?: unknown;
      __REVERIE_BROWSER_FIXTURE__?: unknown;
    };
    if (globals.__REVERIE_BROWSER_FIXTURE__) return;
    if (!globals.__TAURI_INTERNALS__ && !globals.__TAURI__) return;
    let unlisten: (() => void) | undefined;
    let timer: number | undefined;
    void import('@tauri-apps/api/window')
      .then(mod =>
        mod.getCurrentWindow().onMoved(() => {
          if (timer) window.clearTimeout(timer);
          timer = window.setTimeout(() => {
            const workspace = snapshotRef.current?.workspace;
            void saveDispatchWindowPosition({
              dispatchShortcut: workspace?.dispatchShortcut ?? 'CommandOrControl+Shift+Space',
              dispatchDefaultVoice: workspace?.dispatchDefaultVoice !== false,
            });
          }, 600);
        }),
      )
      .then(fn => {
        unlisten = fn;
      })
      .catch(() => {
        /* no window move events available */
      });
    return () => {
      unlisten?.();
      if (timer) window.clearTimeout(timer);
    };
  }, []);

  // Size the window to the panel: it grows as the input grows, and opens extra
  // room below when a dropdown is showing (menus render into that space). A
  // ResizeObserver catches content growth; the menu deps catch the dropdowns
  // (which are absolutely positioned and don't change the panel's own height).
  const applyHeight = () => {
    const panelHeight = panelRef.current?.offsetHeight ?? 124;
    // 24px root padding (top); below the panel, leave shadow room, or enough for
    // a dropdown when one is open. The destination menu opens downward from the
    // panel's bottom edge and is up to 300px tall (DestinationChip menuClass),
    // so reserve that plus margin or its last items get clipped by the window.
    const room = menuOpenRef.current ? 340 : 24;
    void setDispatchWindowHeight(panelHeight + 24 + room);
  };
  useEffect(() => {
    applyHeight();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentMenuOpen, destMenuOpen, text, transcribing, capture.capturing, captureError]);
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => applyHeight());
    observer.observe(panel);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Grow the input to fit its content up to ~5 lines, then scroll. Runs before
  // the window-size effect (layout before passive) so the panel height it reads
  // already includes the grown input.
  useLayoutEffect(() => {
    const element = inputRef.current;
    if (!element) return;
    element.style.height = 'auto';
    const maxHeight = 118; // ~5 lines at the input's line box + padding
    element.style.height = `${Math.min(element.scrollHeight, maxHeight)}px`;
  }, [text]);

  // Reset to a clean slate, cancelling any capture that is live or starting so a
  // stale recording can never be reused by the next open.
  function resetCapture() {
    if (capture.isActive() || capture.isStarting()) void capture.cancel();
    pendingVoiceRef.current = false;
    setText('');
    setRouting(null);
    setRoutingPending(false);
    setManualRouting(false);
    setCaptureError(null);
    lastClassified.current = '';
    classifyToken.current += 1;
  }

  // Re-read the workspace on every open: the popup is a long-lived pre-warmed
  // window, so its settings (start-in-voice, default agent) and routing
  // candidates (projects/topics) would otherwise be frozen at app startup.
  function refreshSnapshot() {
    void fetchWorkspaceShell()
      .then(loaded => {
        setSnapshot(loaded);
        setAgentKind(loaded.workspace.defaultAgentKind);
      })
      .catch(() => {
        /* keep the last snapshot */
      });
  }

  // Start the auto-record if the popup is waiting for it and everything is
  // ready. Called on open and re-tried by the catch-up effect when the engine
  // becomes ready or the refreshed setting arrives.
  function maybeAutoStart() {
    if (!pendingVoiceRef.current) return;
    if (!dispatchDefaultVoice || !voiceReady) return;
    if (capture.isActive() || capture.isStarting() || transcribing) return;
    if (text.trim()) return;
    pendingVoiceRef.current = false;
    void startListening();
  }

  // Surface a capture failure (mic denied / no device / device error) for the
  // CURRENT capture only. The worker emits these out of band; matching the id
  // keeps a stale/foreign error from tearing down a healthy recording or
  // stamping an error onto a transcript that actually succeeded.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void onSpeechError(payload => {
      const current = capture.currentId();
      if (payload.captureId && current && payload.captureId !== current) return;
      if (!capture.isActive() && !capture.isStarting()) return;
      setCaptureError(payload.message || 'Microphone capture failed.');
      setTranscribing(false);
      void capture.cancel();
    }).then(fn => {
      unlisten = fn;
    });
    return () => unlisten?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Begin listening. `start` is a synchronous no-op if a capture is live or
  // already starting (the hook's in-flight guard).
  async function startListening() {
    if (!voiceReady) return;
    pendingVoiceRef.current = false;
    setCaptureError(null);
    await capture.start();
  }

  // Stop + transcribe. Idempotent (guarded), and only ever called with a live
  // capture, so a null result is a genuine transcription failure rather than a
  // "there was nothing to stop".
  async function stopListening() {
    if (stoppingRef.current || !capture.isActive()) return;
    stoppingRef.current = true;
    setTranscribing(true);
    const result = await capture.stop();
    setTranscribing(false);
    stoppingRef.current = false;
    const transcript = result?.text.trim() ?? '';
    if (transcript) {
      setCaptureError(null);
      immediateClassifyRef.current = true;
      setText(result?.text ?? '');
    } else {
      console.warn('[reverie] dispatch: empty/failed transcript', result);
      setCaptureError(
        result === null
          ? "Couldn't record. Check microphone access and try again."
          : 'No speech detected. Check your microphone and try again.',
      );
    }
    // The classify effect picks the new text up; focus for review/edit.
    inputRef.current?.focus();
  }

  // The single shortcut event: the backend shows the window and fires this on
  // every press; the overlay owns the meaning. Recording -> stop; idle -> a
  // fresh capture; mid-start or mid-transcribe -> ignore. Never closes (Escape /
  // click-outside dismiss). Subscribed once; always runs the latest closure.
  const triggerRef = useRef<() => void>(() => {});
  triggerRef.current = () => {
    inputRef.current?.focus();
    if (transcribing || capture.isStarting()) return;
    if (capture.isActive()) {
      void stopListening();
      return;
    }
    // Idle (first open, or after a stop): start from a clean slate. Stamp the
    // open time so the mic-permission dialog's focus grab can't blur-dismiss us.
    openedAtRef.current = performance.now();
    resetCapture();
    setAgentMenuOpen(false);
    setDestMenuOpen(false);
    // Pull fresh settings/projects, then arm + try the auto-record. If the
    // engine (or the refreshed setting) isn't ready this instant, the catch-up
    // effect below starts it as soon as it is.
    refreshSnapshot();
    pendingVoiceRef.current = true;
    maybeAutoStart();
  };
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void onDispatchTrigger(() => triggerRef.current()).then(fn => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, []);

  // Catch-up auto-start: when the engine becomes ready or the refreshed
  // start-in-voice setting arrives after the window opened, begin the armed
  // recording. No-op unless `pendingVoiceRef` is set (so it never records on a
  // hidden/idle window).
  useEffect(() => {
    maybeAutoStart();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voiceReady, dispatchDefaultVoice]);

  // Spotlight-style dismiss: clicking away (window loses focus) cancels any
  // capture and hides. Ignored for a short grace after opening so the
  // first-capture mic-permission dialog can't dismiss the popup as it appears.
  const blurRef = useRef<() => void>(() => {});
  blurRef.current = () => {
    if (performance.now() - openedAtRef.current < 800) return;
    void dismiss();
  };
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void onDispatchWindowBlur(() => blurRef.current()).then(fn => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, []);

  // Resolve routing in the background whenever the (non-manual) text settles. A
  // voice transcript is final, so classify it immediately; typed text is
  // debounced so we don't fire a call on every keystroke.
  useEffect(() => {
    if (manualRouting) return;
    const trimmed = text.trim();
    if (!trimmed) {
      setRouting(null);
      setRoutingPending(false);
      return;
    }
    if (trimmed === lastClassified.current) return;
    const delay = immediateClassifyRef.current ? 0 : 450;
    immediateClassifyRef.current = false;
    setRoutingPending(true);
    if (classifyTimer.current) window.clearTimeout(classifyTimer.current);
    const token = ++classifyToken.current;
    classifyTimer.current = window.setTimeout(() => {
      void classifyDispatch(trimmed)
        .then(result => {
          if (token !== classifyToken.current) return;
          lastClassified.current = trimmed;
          setRouting(result);
        })
        .catch(() => {
          if (token !== classifyToken.current) return;
          lastClassified.current = trimmed;
          setRouting(null); // treated as General at send time
        })
        .finally(() => {
          if (token === classifyToken.current) setRoutingPending(false);
        });
    }, delay);
    return () => {
      if (classifyTimer.current) window.clearTimeout(classifyTimer.current);
    };
  }, [text, manualRouting]);

  // Classify synchronously (used by Send when routing has not settled yet).
  async function classifyNow(prompt: string): Promise<DispatchRouting | null> {
    if (classifyTimer.current) window.clearTimeout(classifyTimer.current);
    classifyToken.current += 1;
    try {
      const result = await classifyDispatch(prompt);
      lastClassified.current = prompt;
      return result;
    } catch {
      return null;
    }
  }

  async function send() {
    const prompt = text.trim();
    if (!prompt) return;
    let finalRouting = routing;
    if (!manualRouting && (routingPending || !finalRouting)) {
      finalRouting = (await classifyNow(prompt)) ?? finalRouting;
    }
    if (!finalRouting) finalRouting = generalRouting(prompt);
    await emitDispatchLaunch({ routing: finalRouting, agentKind, prompt });
    resetCapture();
    await hideDispatchWindow();
  }

  async function dismiss() {
    // resetCapture cancels any live/starting capture; then hide.
    resetCapture();
    await hideDispatchWindow();
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      void dismiss();
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (canSend) void send();
    }
  }

  // Action button: Stop while recording, a spinner while transcribing, Send once
  // there is text, else a prompt to speak (voice ready) or a disabled Send.
  const action: 'stop' | 'processing' | 'send' | 'speak' | 'disabled' = capture.capturing
    ? 'stop'
    : transcribing
      ? 'processing'
      : canSend
        ? 'send'
        : voiceReady
          ? 'speak'
          : 'disabled';

  const actionLabel =
    action === 'stop'
      ? 'Stop recording'
      : action === 'processing'
        ? 'Transcribing'
        : action === 'speak'
          ? 'Start voice input'
          : action === 'send'
            ? 'Send to agent'
            : availability === 'provisioning'
              ? 'Voice is still setting up'
              : availability === 'error'
                ? 'Voice setup failed'
                : "Voice input isn't available";

  return (
    <div
      className={dispatchRootClass}
      data-theme={theme}
      data-testid="dispatch-overlay"
      onMouseDown={event => {
        // A click on the transparent backdrop (outside the panel) dismisses.
        if (event.target === event.currentTarget) void dismiss();
      }}
    >
      <div ref={panelRef} className={dispatchPanelClass}>
        <div className={dragStripClass} data-tauri-drag-region aria-hidden="true" />

        {/* The agent row sits above the destination row so its dropdown overlays
            the destination chip rather than being painted over by it. The action
            button is inline at the end of the input and doubles as the capture
            indicator: mic (idle) -> live waveform (recording) -> racing ring
            (processing) -> send arrow (ready). */}
        <div className={inputRowClass} style={{ zIndex: 3 }}>
          <AgentBadge
            value={agentKind}
            agents={agents}
            onChange={setAgentKind}
            onOpenChange={setAgentMenuOpen}
          />
          <textarea
            ref={inputRef}
            className={inputClass}
            value={text}
            onChange={event => {
              // Typing cancels a pending auto-record so it can't start over the
              // text the user is entering.
              pendingVoiceRef.current = false;
              setManualRouting(false);
              setText(event.target.value);
            }}
            onKeyDown={onKeyDown}
            placeholder={
              capture.capturing
                ? 'Listening…'
                : transcribing
                  ? 'Transcribing…'
                  : availability === 'provisioning'
                    ? 'Type a task… (voice is still setting up)'
                    : availability === 'ready'
                      ? 'Describe a task, or press the shortcut and speak…'
                      : 'Describe a task…'
            }
            rows={1}
            spellCheck={false}
          />
          <button
            type="button"
            className={actionButtonClass}
            data-variant={action}
            disabled={action === 'disabled' || action === 'processing'}
            aria-label={actionLabel}
            title={actionLabel}
            data-testid="dispatch-action"
            onClick={() => {
              if (action === 'stop') void stopListening();
              else if (action === 'send') void send();
              else if (action === 'speak') void startListening();
            }}
          >
            {action === 'stop' ? (
              <ButtonWave level={capture.level} />
            ) : action === 'processing' ? (
              <SpinnerRing />
            ) : action === 'speak' ? (
              <MicGlyph />
            ) : (
              <SendGlyph />
            )}
          </button>
        </div>

        <div className={rowClass}>
          <DestinationChip
            routing={routing}
            pending={routingPending}
            projects={snapshot?.projects ?? []}
            focuses={snapshot?.focuses ?? []}
            generalLabel={generalLabel}
            sessionTitle={routing?.sessionTitle ?? deriveTitle(text)}
            onChange={next => {
              setManualRouting(true);
              setRouting(next);
            }}
            onOpenChange={setDestMenuOpen}
          />
        </div>

        {captureError ? (
          <div className={errorRowClass}>
            <Typography variant="caption" tone="warn" style={{ lineHeight: 1.4 }}>
              {micPermission === 'denied'
                ? 'Microphone access is off. Enable Reverie in System Settings → Privacy & Security → Microphone.'
                : captureError}
            </Typography>
          </div>
        ) : !capture.capturing &&
          !transcribing &&
          voiceEnabled &&
          engine.kind === 'provisioning' ? (
          // First-launch: voice is one-time downloading. Say so, and make clear
          // typing still works, instead of leaving a silently dimmed mic.
          <div className={errorRowClass}>
            <Typography variant="caption" tone="muted" style={{ lineHeight: 1.4 }}>
              {provisioningLabel(engine.phase)}… you can still type a task.
            </Typography>
          </div>
        ) : availability === 'error' ? (
          <div className={errorRowClass}>
            <Typography variant="caption" tone="warn" style={{ lineHeight: 1.4 }}>
              Voice setup failed. You can still type a task; open Settings to retry.
            </Typography>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function MicGlyph() {
  return (
    <svg className={glyphClass} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="9" y="3" width="6" height="11" rx="3" fill="currentColor" />
      <path
        d="M6 11a6 6 0 0 0 12 0M12 17v3.5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  );
}

// A racing arc around the button while the transcript is being produced.
function SpinnerRing() {
  return (
    <svg className={spinnerClass} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="var(--line-strong)" strokeWidth="2" />
      <path d="M12 3a9 9 0 0 1 9 9" stroke="var(--good)" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function SendGlyph() {
  return (
    <svg className={glyphClass} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 19V6M6 11l6-6 6 6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}

// A compact live waveform that fills the action button while recording: a few
// bars that breathe with the mic level. The raw RMS is tiny (~0.02–0.2), so it
// is lifted with gain + a perceptual curve, then shaped by a centered bell and a
// travelling sine so it reads as a lively wave. Animated on rAF with direct DOM
// writes (no per-frame React render), eased toward the target.
const WAVE_BARS = 4;
const WAVE_MIN = 0.18; // resting bar height fraction
const WAVE_GAIN = 7; // lift for the small RMS values

function ButtonWave({ level }: { level: number }) {
  const levelRef = useRef(level);
  levelRef.current = level;
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const bars = Array.from(container.children) as HTMLElement[];
    const heights = bars.map(() => WAVE_MIN);
    let frame = 0;
    let raf = 0;
    const center = (WAVE_BARS - 1) / 2;

    const tick = () => {
      frame += 1;
      // Perceptual energy from the raw RMS.
      const energy = Math.min(1, Math.sqrt(Math.max(0, levelRef.current) * WAVE_GAIN));
      for (let i = 0; i < bars.length; i++) {
        // Centered bell so the middle bars lead; a travelling sine adds life.
        const bell = 1 - Math.abs(i - center) / (center + 1.2);
        const wave = 0.55 + 0.45 * Math.sin(frame * 0.2 + i * 0.9);
        const target = WAVE_MIN + energy * bell * wave * (1 - WAVE_MIN);
        const ease = target > heights[i]! ? 0.5 : 0.22;
        heights[i] = heights[i]! + (target - heights[i]!) * ease;
        bars[i]!.style.transform = `scaleY(${Math.max(WAVE_MIN, heights[i]!).toFixed(3)})`;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div ref={containerRef} className={buttonWaveClass} aria-hidden="true">
      {Array.from({ length: WAVE_BARS }, (_, index) => (
        <span key={index} className={buttonWaveBarClass} />
      ))}
    </div>
  );
}

// The rim-lit panel, self-contained (not the shared rimLitPanelClass) so it can
// keep `overflow: visible` — the agent/destination dropdowns escape the panel
// into the transparent window space below, and the window grows to fit them.
const dispatchPanelClass = css({
  position: 'relative',
  width: 'min(540px, calc(100vw - 56px))',
  background: 'var(--surface-1)',
  borderRadius: '22px',
  // A tighter shadow than the app's panels (var(--shadow) is 60px blur / 30px
  // offset): the popup window is only a little larger than the card, so a big
  // shadow gets clipped at the window edge. This stays within the 24px margin.
  boxShadow: '0 8px 22px -10px rgba(0, 0, 0, 0.5)',
  overflow: 'visible',
  display: 'flex',
  flexDirection: 'column',
  gap: '10px',
  paddingX: '16px',
  paddingTop: '6px',
  paddingBottom: '14px',
  // The signature conic rim highlight (mirrors themes/surfaces.ts rimLitPanel).
  '&::before': {
    content: '""',
    position: 'absolute',
    inset: 0,
    borderRadius: 'inherit',
    padding: '1.2px',
    background:
      'conic-gradient(from 180deg at 25% 18%, var(--rim-2) 0deg, var(--rim-2) 40deg, var(--rim-1) 130deg, var(--rim-1) 175deg, var(--rim-2) 240deg, var(--rim-2) 360deg)',
    WebkitMask: 'linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)',
    WebkitMaskComposite: 'xor',
    maskComposite: 'exclude',
    pointerEvents: 'none',
    zIndex: 0,
  },
});

const dragStripClass = css({ height: '14px', flexShrink: 0, cursor: 'default' });

const rowClass = css({
  position: 'relative',
  zIndex: 2,
  display: 'flex',
  alignItems: 'center',
  gap: '10px',
});

const errorRowClass = css({
  position: 'relative',
  zIndex: 2,
  display: 'flex',
  alignItems: 'center',
  paddingX: '2px',
});

// The input row aligns to the bottom so the agent badge and action button stay
// pinned to the last line as the textarea grows upward.
const inputRowClass = css({
  position: 'relative',
  zIndex: 2,
  display: 'flex',
  alignItems: 'flex-end',
  gap: '10px',
});

const inputClass = css({
  flex: 1,
  minWidth: 0,
  resize: 'none',
  border: 'none',
  outline: 'none',
  background: 'transparent',
  color: 'var(--text)',
  fontFamily: 'inherit',
  fontSize: '15px',
  lineHeight: '1.45',
  letterSpacing: '-0.01em',
  paddingY: '6px',
  // Height is set imperatively to fit content up to ~5 lines; beyond that it
  // scrolls.
  overflowY: 'auto',
  userSelect: 'text',
  WebkitUserSelect: 'text',
  '&::placeholder': { color: 'var(--text-3)' },
});

const buttonWaveClass = css({
  display: 'inline-flex',
  alignItems: 'center',
  gap: '2px',
  height: '16px',
});

const buttonWaveBarClass = css({
  width: '2.5px',
  height: '16px',
  borderRadius: '999px',
  background: 'var(--good)',
  transformOrigin: 'center',
  willChange: 'transform',
});

// A single round button that doubles as the capture-state indicator: mic
// (idle), a live waveform (recording), a racing ring (processing), a send arrow
// (ready).
const actionButtonClass = css({
  flexShrink: 0,
  display: 'inline-grid',
  placeItems: 'center',
  width: '38px',
  height: '38px',
  borderRadius: '999px',
  border: '1px solid var(--line-strong)',
  background: 'var(--surface-hi)',
  color: 'var(--text)',
  cursor: 'pointer',
  transition: 'opacity 0.15s ease, background 0.15s ease, border-color 0.15s ease',
  _hover: { background: 'var(--surface-3)' },
  _disabled: { cursor: 'default' },
  // Recording reads as live: a status-good rim around the waveform.
  '&[data-variant="stop"]': { borderColor: 'var(--good)' },
  '&[data-variant="disabled"]': { opacity: 0.35 },
});

const glyphClass = css({ width: '18px', height: '18px', display: 'block' });

const spinnerClass = css({
  width: '26px',
  height: '26px',
  display: 'block',
  animation: 'dispatchSpin 0.8s linear infinite',
});
