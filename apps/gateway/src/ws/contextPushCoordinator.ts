import type { ContextSnapshotReason, SessionContext } from "@local-terminal/shared";
import type { AppLogger } from "../utils/logger.js";

const OPEN = 1;

const REASON_PRIORITY: Record<ContextSnapshotReason, number> = {
  connect: 5,
  submit: 4,
  heartbeat: 3,
  resize: 2,
  stdout: 1
};

function pickHighestPriorityReason(reasons: Set<ContextSnapshotReason>): ContextSnapshotReason {
  let best: ContextSnapshotReason = "stdout";
  let bestScore = -1;
  for (const reason of reasons) {
    const score = REASON_PRIORITY[reason] ?? 0;
    if (score > bestScore) {
      best = reason;
      bestScore = score;
    }
  }
  return best;
}

interface PushSocketLike {
  readyState: number;
  send(payload: string): void;
}

export interface ContextPushCoordinatorOptions {
  sessionId: string;
  socket: PushSocketLike;
  debounceMs: number;
  heartbeatMs: number;
  buildSnapshot: () => Promise<SessionContext | null>;
  logger?: AppLogger;
}

export interface ContextPushCoordinator {
  queue(reason: ContextSnapshotReason, urgent?: boolean): void;
  dispose(): void;
}

export function createContextPushCoordinator(options: ContextPushCoordinatorOptions): ContextPushCoordinator {
  const { sessionId, socket, debounceMs, heartbeatMs, buildSnapshot, logger } = options;
  let contextPushInFlight = false;
  let contextPushPendingUrgent = false;
  let contextPushLastAt = 0;
  const contextPushPendingReasons = new Set<ContextSnapshotReason>();
  let contextPushDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  let contextPushHeartbeatTimer: ReturnType<typeof setInterval> | null = setInterval(() => {
    queue("heartbeat", true);
  }, heartbeatMs);
  let contextPushDisposed = false;

  const clearContextPushDebounce = () => {
    if (contextPushDebounceTimer !== null) {
      clearTimeout(contextPushDebounceTimer);
      contextPushDebounceTimer = null;
    }
  };

  const dispose = () => {
    contextPushDisposed = true;
    clearContextPushDebounce();
    if (contextPushHeartbeatTimer !== null) {
      clearInterval(contextPushHeartbeatTimer);
      contextPushHeartbeatTimer = null;
    }
    contextPushPendingReasons.clear();
    contextPushPendingUrgent = false;
  };

  const flushContextSnapshotPush = async (forceImmediate: boolean) => {
    if (contextPushDisposed || socket.readyState !== OPEN || contextPushInFlight || contextPushPendingReasons.size === 0) {
      return;
    }

    if (!forceImmediate) {
      const elapsed = Date.now() - contextPushLastAt;
      if (elapsed < debounceMs) {
        if (contextPushDebounceTimer === null) {
          const delay = Math.max(1, debounceMs - elapsed);
          contextPushDebounceTimer = setTimeout(() => {
            contextPushDebounceTimer = null;
            void flushContextSnapshotPush(false);
          }, delay);
        }
        return;
      }
    }

    clearContextPushDebounce();
    const reason = pickHighestPriorityReason(contextPushPendingReasons);
    contextPushPendingReasons.clear();
    contextPushPendingUrgent = false;
    contextPushInFlight = true;
    try {
      const snapshot = await buildSnapshot();
      if (snapshot && !contextPushDisposed && socket.readyState === OPEN) {
        const updatedAt = Date.now();
        contextPushLastAt = updatedAt;
        socket.send(
          JSON.stringify({
            type: "meta",
            data: {
              kind: "context_snapshot",
              snapshot,
              updatedAt,
              reason
            }
          })
        );
      }
    } catch (error) {
      logger?.warn({ code: "context_snapshot_push_failed", sessionId, error });
    }

    contextPushInFlight = false;
    if (contextPushDisposed || socket.readyState !== OPEN || contextPushPendingReasons.size === 0) {
      return;
    }

    if (contextPushPendingUrgent) {
      void flushContextSnapshotPush(true);
      return;
    }

    const elapsed = Date.now() - contextPushLastAt;
    if (elapsed >= debounceMs) {
      void flushContextSnapshotPush(false);
      return;
    }

    if (contextPushDebounceTimer === null) {
      const delay = Math.max(1, debounceMs - elapsed);
      contextPushDebounceTimer = setTimeout(() => {
        contextPushDebounceTimer = null;
        void flushContextSnapshotPush(false);
      }, delay);
    }
  };

  const queue = (reason: ContextSnapshotReason, urgent = false) => {
    if (contextPushDisposed) {
      return;
    }

    contextPushPendingReasons.add(reason);

    if (urgent) {
      contextPushPendingUrgent = true;
      clearContextPushDebounce();
      void flushContextSnapshotPush(true);
      return;
    }

    if (contextPushInFlight) {
      return;
    }

    const elapsed = Date.now() - contextPushLastAt;
    if (elapsed >= debounceMs) {
      void flushContextSnapshotPush(false);
      return;
    }

    if (contextPushDebounceTimer === null) {
      const delay = Math.max(1, debounceMs - elapsed);
      contextPushDebounceTimer = setTimeout(() => {
        contextPushDebounceTimer = null;
        void flushContextSnapshotPush(false);
      }, delay);
    }
  };

  return { queue, dispose };
}
