import { useCallback } from "react";

const STORAGE_SESSION_KEY = "local-web-terminal:session";

type SessionStorageReader = Pick<Storage, "getItem">;
type SessionStorageWriter = Pick<Storage, "setItem">;

export function readTabSessionId(storage?: SessionStorageReader): string | null {
  const target = storage ?? (typeof window !== "undefined" ? window.sessionStorage : null);
  if (!target) {
    return null;
  }
  return target.getItem(STORAGE_SESSION_KEY);
}

export function writeTabSessionId(sessionId: string, storage?: SessionStorageWriter): void {
  const target = storage ?? (typeof window !== "undefined" ? window.sessionStorage : null);
  if (!target) {
    return;
  }
  target.setItem(STORAGE_SESSION_KEY, sessionId);
}

interface UseSessionBootstrapOptions {
  createSession: () => Promise<string>;
}

export function useSessionBootstrap(options: UseSessionBootstrapOptions) {
  const { createSession } = options;
  const bootSession = useCallback(async (): Promise<string> => {
    let sessionId = readTabSessionId();
    if (!sessionId) {
      sessionId = await createSession();
      writeTabSessionId(sessionId);
    }
    return sessionId;
  }, [createSession]);

  return { bootSession };
}
