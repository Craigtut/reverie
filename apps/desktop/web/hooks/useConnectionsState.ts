// React hooks for the inter-agent connection feature.
//
// Three independently-loaded slices of state:
// - Bridge installation status, refreshed manually after install/uninstall.
// - Connection policy, mutable via setConnectionPolicy.
// - Pending connection requests, live-updated via the
//   `connection_request_changed` Tauri event.
//
// Each hook owns its lifecycle (load on mount, subscribe to relevant events,
// expose a typed `refresh` / mutator). The settings panel and the banner
// compose them at their respective layout points.

import { useCallback, useEffect, useState } from 'react';

import {
  acceptConnectionRequest,
  denyConnectionRequest,
  fetchBridgeInstallationStatus,
  fetchConnectionPolicy,
  installClaudeBridge,
  installCodexBridge,
  installCortexBridge,
  listPendingConnectionRequests,
  onConnectionRequestChange,
  onConnectionStateChange,
  setConnectionPolicy as setConnectionPolicyApi,
  uninstallClaudeBridge,
  uninstallCodexBridge,
  uninstallCortexBridge,
} from '../services/connectionsApi';
import type {
  BridgeCliKind,
  BridgeStatusReport,
  ConnectionPolicy,
  ConnectionRequestView,
} from '../domain';

export function useBridgeInstallationStatus() {
  const [status, setStatus] = useState<BridgeStatusReport | null>(null);
  const [loading, setLoading] = useState(false);
  // Which CLI's install/uninstall is currently in flight, if any. The UI
  // uses this to render a per-row pending state instead of a global spinner.
  const [busyCli, setBusyCli] = useState<BridgeCliKind | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await fetchBridgeInstallationStatus();
      setStatus(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const install = useCallback(async (cli: BridgeCliKind) => {
    setBusyCli(cli);
    setError(null);
    try {
      const next = await (cli === 'cortex'
        ? installCortexBridge()
        : cli === 'codex'
          ? installCodexBridge()
          : installClaudeBridge());
      setStatus(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyCli(null);
    }
  }, []);

  const uninstall = useCallback(async (cli: BridgeCliKind) => {
    setBusyCli(cli);
    setError(null);
    try {
      const next = await (cli === 'cortex'
        ? uninstallCortexBridge()
        : cli === 'codex'
          ? uninstallCodexBridge()
          : uninstallClaudeBridge());
      setStatus(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyCli(null);
    }
  }, []);

  return { status, loading, busyCli, error, refresh, install, uninstall };
}

export function useConnectionPolicy() {
  const [policy, setPolicy] = useState<ConnectionPolicy | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchConnectionPolicy()
      .then(value => {
        if (!cancelled) setPolicy(value);
      })
      .catch(err => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const update = useCallback(async (next: ConnectionPolicy) => {
    setError(null);
    try {
      const applied = await setConnectionPolicyApi(next);
      setPolicy(applied);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  return { policy, error, update };
}

export function useConnectionRequests() {
  const [requests, setRequests] = useState<ConnectionRequestView[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await listPendingConnectionRequests();
      setRequests(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
    // If the cleanup runs before the listener subscription resolves, store
    // the stop fn so the .then() can call it immediately. Without this the
    // Tauri event subscription leaks across unmount/effect-rerun cycles.
    let stop: (() => void) | null = null;
    let cancelled = false;
    void onConnectionRequestChange(() => {
      void refresh();
    }).then(fn => {
      if (cancelled) {
        fn();
        return;
      }
      stop = fn;
      // Re-sync once the listener is live: a request that arrived between the
      // initial fetch above and this subscription registering would otherwise
      // be missed (there is no polling fallback). This closes that window.
      void refresh();
    });
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [refresh]);

  // Also refresh on state changes so the banner clears once an accept lands
  // through any path.
  useEffect(() => {
    let stop: (() => void) | null = null;
    let cancelled = false;
    void onConnectionStateChange(() => {
      void refresh();
    }).then(fn => {
      if (cancelled) fn();
      else stop = fn;
    });
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [refresh]);

  const accept = useCallback(
    async (requestId: string) => {
      await acceptConnectionRequest(requestId);
      await refresh();
    },
    [refresh],
  );

  const deny = useCallback(
    async (requestId: string, reason: string | null = null) => {
      await denyConnectionRequest(requestId, reason);
      await refresh();
    },
    [refresh],
  );

  return { requests, error, refresh, accept, deny };
}
