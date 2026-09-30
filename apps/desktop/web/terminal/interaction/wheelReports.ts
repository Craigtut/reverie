// Paces wheel input into SGR wheel reports for apps that capture the mouse
// (Claude Code and Codex fullscreen, vim, htop). Browsers deliver a trackpad
// swipe as dozens of small-delta events plus momentum; forwarding one report
// per DOM event makes every tiny movement a full scroll step in the app. Native
// terminals (Ghostty) instead accumulate pixel travel and emit one report per
// cell of movement, carrying the remainder. This does the same, and lets the
// caller scale the step to how many rows the app scrolls per report so content
// tracks the pointer.

// A wheel event arriving after this much quiet starts a new gesture. The first
// event of a gesture always yields at least one report, so a discrete mouse
// notch (which WebKit can report as a small pixel delta) still scrolls.
export const WHEEL_GESTURE_IDLE_MS = 160;

export class WheelReportAccumulator {
  private pendingPixels = 0;
  private lastEventAt: number | null = null;

  // Fold one wheel delta in and return the signed number of reports to send
  // (negative scrolls up). `pixelsPerReport` is the pointer travel one report
  // stands for; `maxReports` bounds a single event's burst.
  take(options: {
    deltaPixels: number;
    pixelsPerReport: number;
    maxReports: number;
    now: number;
  }): number {
    const { deltaPixels, pixelsPerReport, now } = options;
    const maxReports = Math.max(1, Math.floor(options.maxReports));
    if (!Number.isFinite(deltaPixels) || deltaPixels === 0 || !(pixelsPerReport > 0)) return 0;

    const newGesture = this.lastEventAt === null || now - this.lastEventAt >= WHEEL_GESTURE_IDLE_MS;
    this.lastEventAt = now;
    // A direction flip, or a fresh gesture, drops travel left over from before.
    if (newGesture || Math.sign(this.pendingPixels) !== Math.sign(deltaPixels)) {
      this.pendingPixels = 0;
    }

    this.pendingPixels += deltaPixels;
    // `+ 0` folds -0 into 0 for a sub-step upward delta.
    let reports = Math.trunc(this.pendingPixels / pixelsPerReport) + 0;
    if (reports === 0 && newGesture) reports = Math.sign(deltaPixels);
    this.pendingPixels -= reports * pixelsPerReport;
    if (newGesture && Math.sign(this.pendingPixels) !== Math.sign(deltaPixels)) {
      // The guaranteed first report overshot the travel; start from zero.
      this.pendingPixels = 0;
    }
    if (Math.abs(reports) > maxReports) {
      // Drop the excess instead of queueing it, so one huge event cannot
      // scroll on long after the pointer stopped.
      reports = Math.sign(reports) * maxReports;
      this.pendingPixels = 0;
    }
    return reports;
  }

  reset() {
    this.pendingPixels = 0;
    this.lastEventAt = null;
  }
}
