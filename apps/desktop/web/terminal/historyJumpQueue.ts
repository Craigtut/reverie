export interface HistoryJumpRequest {
  sessionId: string;
  cols: number;
  rows: number;
  targetRow: number;
  knownTotalRows?: number;
}

export interface LatestHistoryJumpQueue {
  enqueue: (request: HistoryJumpRequest) => Promise<boolean>;
  clear: () => void;
  hasPending: () => boolean;
  isBusy: () => boolean;
}

export function createLatestHistoryJumpQueue(
  executor: (request: HistoryJumpRequest) => Promise<boolean>,
): LatestHistoryJumpQueue {
  let inFlight = false;
  let inFlightRequest: HistoryJumpRequest | null = null;
  let pending: HistoryJumpRequest | null = null;
  let token = 0;

  async function run(request: HistoryJumpRequest, runToken: number): Promise<boolean> {
    try {
      return await executor(request);
    } finally {
      if (runToken === token) {
        const next = pending;
        pending = null;
        if (next) {
          const nextToken = token + 1;
          token = nextToken;
          inFlight = true;
          inFlightRequest = next;
          void run(next, nextToken).catch(() => undefined);
        } else {
          inFlight = false;
          inFlightRequest = null;
        }
      }
    }
  }

  return {
    enqueue(request) {
      if (inFlight) {
        if (inFlightRequest && sameHistoryJumpRequest(inFlightRequest, request)) {
          return Promise.resolve(true);
        }
        if (pending && sameHistoryJumpRequest(pending, request)) {
          return Promise.resolve(true);
        }
        pending = request;
        return Promise.resolve(true);
      }

      const nextToken = token + 1;
      token = nextToken;
      inFlight = true;
      inFlightRequest = request;
      return run(request, nextToken);
    },
    clear() {
      token += 1;
      inFlight = false;
      inFlightRequest = null;
      pending = null;
    },
    hasPending() {
      return pending !== null;
    },
    isBusy() {
      return inFlight || pending !== null;
    },
  };
}

function sameHistoryJumpRequest(left: HistoryJumpRequest, right: HistoryJumpRequest) {
  return (
    left.sessionId === right.sessionId &&
    left.cols === right.cols &&
    left.rows === right.rows &&
    left.targetRow === right.targetRow &&
    left.knownTotalRows === right.knownTotalRows
  );
}
