export interface LogPayload {
  code: string;
  sessionId?: string;
  paneId?: string;
  error?: unknown;
  details?: Record<string, unknown>;
}

export interface AppLogger {
  warn(payload: LogPayload): void;
}

interface WarnLike {
  warn: (...args: unknown[]) => void;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error ?? "");
}

export function createAppLogger(target?: WarnLike): AppLogger {
  return {
    warn(payload) {
      const normalized = {
        ...payload,
        error: payload.error === undefined ? undefined : toErrorMessage(payload.error)
      };
      if (target?.warn) {
        target.warn(normalized, "gateway_warning");
        return;
      }
      console.warn("gateway_warning", normalized);
    }
  };
}
