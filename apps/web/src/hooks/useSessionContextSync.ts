import { useCallback, useMemo, useRef, type MutableRefObject } from "react";
import type { EnvContext, SessionContext } from "@local-terminal/shared";
import {
  createEmptyContext,
  mergeIncomingContext,
  syncEnvContextFromSnapshot,
  writeSnapshotScripts
} from "../services/snapshotWriter.js";
import { createApiClient } from "../services/apiClient.js";

function logWarn(code: string, error?: unknown): void {
  if (!import.meta.env.DEV) {
    return;
  }
  console.warn(code, error);
}

interface UseSessionContextSyncOptions {
  gatewayBase: string;
  isSessionCurrent: (sessionId: string | null | undefined) => sessionId is string;
  sessionIdRef: MutableRefObject<string | null>;
}

interface UseSessionContextSyncResult {
  latestContextRef: MutableRefObject<SessionContext>;
  latestEnvContextRef: MutableRefObject<EnvContext | null>;
  refreshContext: (sessionIdHint?: string) => Promise<boolean>;
  onContextSnapshot: (snapshot: SessionContext, updatedAt: number, targetSessionId: string) => void;
  onEnvProbe: (incoming: EnvContext, targetSessionId: string) => void;
  resetContextSidecar: () => void;
  seedSessionContext: (nextSessionId: string) => void;
}

export function useSessionContextSync(options: UseSessionContextSyncOptions): UseSessionContextSyncResult {
  const { gatewayBase, isSessionCurrent, sessionIdRef } = options;
  const api = useMemo(() => createApiClient(gatewayBase), [gatewayBase]);
  const latestContextRef = useRef<SessionContext>(createEmptyContext());
  const latestEnvContextRef = useRef<EnvContext | null>(null);

  const refreshContext = useCallback(async (sessionIdHint?: string) => {
    const targetSessionId = sessionIdHint ?? sessionIdRef.current;
    if (!isSessionCurrent(targetSessionId)) {
      return false;
    }

    try {
      const context = await api<SessionContext>(`/api/context/${targetSessionId}`);
      if (!isSessionCurrent(targetSessionId)) {
        return false;
      }
      if (context.sessionId && context.sessionId !== targetSessionId) {
        logWarn("context_refresh_session_mismatch", {
          expectedSessionId: targetSessionId,
          actualSessionId: context.sessionId
        });
        return false;
      }

      const mergedContext = mergeIncomingContext(context);
      const syncedEnvContext = syncEnvContextFromSnapshot(
        { ...mergedContext, updatedAt: Date.now() },
        latestEnvContextRef.current
      );

      latestEnvContextRef.current = syncedEnvContext;
      latestContextRef.current = mergedContext;
      writeSnapshotScripts({
        context: mergedContext,
        updatedAt: Date.now(),
        envContext: syncedEnvContext
      });
      return true;
    } catch (error) {
      logWarn("context_refresh_failed", error);
      return false;
    }
  }, [api, isSessionCurrent, sessionIdRef]);

  const onContextSnapshot = useCallback((snapshot: SessionContext, updatedAt: number, targetSessionId: string) => {
    if (!isSessionCurrent(targetSessionId)) {
      return;
    }
    if (snapshot.sessionId && snapshot.sessionId !== targetSessionId) {
      logWarn("context_snapshot_session_mismatch", {
        expectedSessionId: targetSessionId,
        actualSessionId: snapshot.sessionId
      });
      return;
    }

    const mergedContext = mergeIncomingContext(snapshot);
    const syncedEnvContext = syncEnvContextFromSnapshot(
      { ...mergedContext, updatedAt },
      latestEnvContextRef.current
    );

    latestEnvContextRef.current = syncedEnvContext;
    latestContextRef.current = mergedContext;
    writeSnapshotScripts({
      context: mergedContext,
      updatedAt,
      envContext: syncedEnvContext
    });
  }, [isSessionCurrent]);

  const onEnvProbe = useCallback((incoming: EnvContext, targetSessionId: string) => {
    if (!isSessionCurrent(targetSessionId)) {
      return;
    }

    const current = latestEnvContextRef.current;
    if (!current || incoming.version >= current.version) {
      latestEnvContextRef.current = incoming;
      writeSnapshotScripts({
        context: latestContextRef.current,
        updatedAt: Date.now(),
        envContext: incoming
      });
    }
  }, [isSessionCurrent]);

  const resetContextSidecar = useCallback(() => {
    latestContextRef.current = createEmptyContext();
    latestEnvContextRef.current = null;
    writeSnapshotScripts({
      context: createEmptyContext(),
      updatedAt: Date.now(),
      envContext: null
    });
  }, []);

  const seedSessionContext = useCallback((nextSessionId: string) => {
    latestContextRef.current = {
      ...createEmptyContext(),
      sessionId: nextSessionId
    };

    writeSnapshotScripts({
      context: latestContextRef.current,
      updatedAt: Date.now(),
      envContext: latestEnvContextRef.current
    });
  }, []);

  return {
    latestContextRef,
    latestEnvContextRef,
    refreshContext,
    onContextSnapshot,
    onEnvProbe,
    resetContextSidecar,
    seedSessionContext
  };
}
