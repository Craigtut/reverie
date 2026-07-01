import { useCallback, useEffect, useRef, useState } from 'react';

import type { TranscriptResult } from '../domain';
import { speechCancelCapture, speechStartCapture, speechStopCapture } from '../services/speechApi';

export interface SpeechCapture {
  // True while a capture is live (between start and stop/cancel).
  capturing: boolean;
  // Latest microphone RMS level in 0..1, for a listening meter. 0 when idle.
  level: number;
  // Begin a capture (e.g. on press). No-op if already capturing.
  start: () => Promise<void>;
  // Finish + transcribe (e.g. on release). Returns the transcript to the caller,
  // which decides what to do with it (the foundation routes it nowhere). Returns
  // null if there was no active capture.
  stop: () => Promise<TranscriptResult | null>;
  // Abort: drop the audio, no transcript.
  cancel: () => Promise<void>;
  // Whether a capture id is currently held (the synchronous source of truth,
  // ahead of the `capturing` render state). Use this to decide stop-vs-start so
  // a lagging render can't misroute the toggle.
  isActive: () => boolean;
  // True between calling `start` and the capture id resolving. During this
  // window `isActive()` is still false, so callers must check this to avoid
  // launching a second overlapping capture.
  isStarting: () => boolean;
  // The capture id currently held, or null. Used to match an out-of-band
  // `speech_error` to the live capture (ignore errors for a different one).
  currentId: () => string | null;
}

// Imperative microphone-capture handle that future voice surfaces (a dispatch
// shortcut, an in-terminal voice button) drive. It owns the capture id and the
// live level; it deliberately does not route the transcript, leaving that to the
// caller of `stop`. Audio never touches JS: capture and transcription happen in
// the Rust backend; only the level and the final text cross the boundary.
export function useSpeechCapture(): SpeechCapture {
  const captureIdRef = useRef<string | null>(null);
  // Set synchronously across the `start` IPC round-trip so a second `start`
  // can't slip through the `captureIdRef`-null window and open a duplicate
  // capture (the worker silently supersedes, leaving the frontend holding the
  // wrong id). This is the in-flight guard.
  const startingRef = useRef(false);
  const [capturing, setCapturing] = useState(false);
  const [level, setLevel] = useState(0);

  const start = useCallback(async () => {
    if (startingRef.current || captureIdRef.current) return;
    startingRef.current = true;
    try {
      const id = await speechStartCapture(signal => {
        if (signal.kind === 'level') setLevel(signal.rms);
      });
      captureIdRef.current = id;
      setCapturing(true);
    } catch {
      captureIdRef.current = null;
      setCapturing(false);
      setLevel(0);
    } finally {
      startingRef.current = false;
    }
  }, []);

  const stop = useCallback(async (): Promise<TranscriptResult | null> => {
    const id = captureIdRef.current;
    captureIdRef.current = null;
    setCapturing(false);
    setLevel(0);
    if (!id) return null;
    // `null` is the single "nothing usable" signal: no active capture, or the
    // engine failed to transcribe. Swallowing the rejection here (rather than
    // letting it propagate) keeps callers from needing a try/catch around a
    // primitive; the error is logged for debugging.
    try {
      return await speechStopCapture(id);
    } catch (error) {
      console.error('[reverie] speech transcription failed', error);
      return null;
    }
  }, []);

  const cancel = useCallback(async () => {
    const id = captureIdRef.current;
    captureIdRef.current = null;
    setCapturing(false);
    setLevel(0);
    if (id) await speechCancelCapture(id);
  }, []);

  const isActive = useCallback(() => captureIdRef.current !== null, []);
  const isStarting = useCallback(() => startingRef.current, []);
  const currentId = useCallback(() => captureIdRef.current, []);

  // Drop a live capture if the consumer unmounts mid-recording.
  useEffect(() => {
    return () => {
      const id = captureIdRef.current;
      if (id) void speechCancelCapture(id);
    };
  }, []);

  return { capturing, level, start, stop, cancel, isActive, isStarting, currentId };
}
