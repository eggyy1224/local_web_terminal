import type { PaneView } from "@local-terminal/shared";
import { maskSensitive } from "@local-terminal/security";

export function paneError(code: string, error: unknown, paneId?: string): string {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  const masked = maskSensitive(raw);
  const suffix = masked ? `:${masked}` : "";
  return paneId ? `${code}:${paneId}${suffix}` : `${code}${suffix}`;
}

export function mergeRecentErrors(
  existing: string[],
  runtimeErrors: string[],
  panes: PaneView[],
  limit = 20
): string[] {
  const merged = [...existing, ...runtimeErrors];
  for (const pane of panes) {
    for (const error of pane.errors ?? []) {
      merged.push(error);
    }
  }
  return merged.slice(-limit);
}
