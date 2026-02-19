import { spawnSync } from "node:child_process";
import { expect, test, type Page } from "@playwright/test";

const GATEWAY_BASE = "http://127.0.0.1:8787";
const SESSION_STORAGE_KEY = "local-web-terminal:session";
const REQUIRED_SNAPSHOT_KEYS = [
  "timestamp",
  "cwd",
  "repoRoot",
  "branch",
  "gitStatusPorcelain",
  "diffStat",
  "recentErrors",
  "tmuxPanes"
];

async function waitForSessionId(page: Page): Promise<string> {
  let sessionId = "";
  await expect
    .poll(
      async () => {
        sessionId =
          (await page.evaluate((storageKey) => window.sessionStorage.getItem(storageKey), SESSION_STORAGE_KEY)) ?? "";
        return sessionId;
      },
      {
        timeout: 20_000,
        message: "session id was not created in sessionStorage"
      }
    )
    .toMatch(/^s_/);
  return sessionId;
}

async function waitForMarkerInRecentOutput(page: Page, sessionId: string, marker: string): Promise<void> {
  const startedAt = Date.now();
  const timeoutMs = 25_000;
  let lastOutputTail = "";
  let lastStatus = -1;

  while (Date.now() - startedAt < timeoutMs) {
    const response = await page.request.get(`${GATEWAY_BASE}/api/context/${sessionId}`);
    lastStatus = response.status();
    if (response.ok()) {
      const payload = (await response.json()) as {
        recentOutput?: unknown;
      };
      const recentOutput = Array.isArray(payload.recentOutput) ? payload.recentOutput.filter((item) => typeof item === "string") : [];
      lastOutputTail = recentOutput.slice(-5).join("\n");
      if (recentOutput.some((line) => line.includes(marker))) {
        return;
      }
    }

    await page.waitForTimeout(300);
  }

  throw new Error(
    `marker_not_found sessionId=${sessionId} marker=${marker} status=${lastStatus} recentOutputTail=${JSON.stringify(lastOutputTail)}`
  );
}

function waitForNextSessionStreamReady(page: Page, sessionId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const targetPath = `/ws/sessions/${sessionId}/stream`;
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`stream_not_ready sessionId=${sessionId}`));
    }, 15_000);

    let targetSocket:
      | {
          on(event: string, listener: (...args: unknown[]) => void): void;
          off?: (event: string, listener: (...args: unknown[]) => void) => void;
          removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
        }
      | null = null;

    let onFrameSent: ((event: { payload?: unknown }) => void) | null = null;
    let onClose: (() => void) | null = null;
    let onSocketError: ((error: Error) => void) | null = null;

    const detachSocketListeners = () => {
      if (!targetSocket || !onFrameSent || !onClose || !onSocketError) {
        return;
      }

      if (targetSocket.off) {
        targetSocket.off("framesent", onFrameSent);
        targetSocket.off("close", onClose);
        targetSocket.off("socketerror", onSocketError);
      } else if (targetSocket.removeListener) {
        targetSocket.removeListener("framesent", onFrameSent);
        targetSocket.removeListener("close", onClose);
        targetSocket.removeListener("socketerror", onSocketError);
      }
    };

    const cleanup = () => {
      clearTimeout(timeout);
      page.off("websocket", onWebSocket);
      detachSocketListeners();
    };

    const onWebSocket = (socket: {
      url(): string;
      on(event: string, listener: (...args: unknown[]) => void): void;
      off?: (event: string, listener: (...args: unknown[]) => void) => void;
      removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
    }) => {
      if (!socket.url().includes(targetPath)) {
        return;
      }

      detachSocketListeners();
      targetSocket = socket;

      onFrameSent = (event: { payload?: unknown }) => {
        const payload = typeof event.payload === "string" ? event.payload : "";
        if (payload.includes("\"type\":\"resize\"")) {
          cleanup();
          resolve();
        }
      };

      onClose = () => {
        cleanup();
        reject(new Error(`stream_closed_before_ready sessionId=${sessionId}`));
      };

      onSocketError = (error: Error) => {
        cleanup();
        reject(new Error(`stream_socket_error sessionId=${sessionId} message=${error.message}`));
      };

      socket.on("framesent", onFrameSent);
      socket.on("close", onClose);
      socket.on("socketerror", onSocketError);
    };

    page.on("websocket", onWebSocket);
  });
}

test("terminal smoke: snapshot, command stream and reload reconnect", async ({ page }) => {
  const tmuxVersion = spawnSync("tmux", ["-V"], { encoding: "utf8" });
  test.skip(tmuxVersion.status !== 0, `tmux is required for e2e, got: ${tmuxVersion.stderr || tmuxVersion.stdout}`);

  await page.goto("/");
  await expect(page.locator(".terminal-root")).toHaveCount(1);
  await expect(page.locator("button")).toHaveCount(0);
  await expect(page.locator("aside")).toHaveCount(0);

  const snapshotText = await page.locator("#snapshot-json").textContent();
  expect(snapshotText).toBeTruthy();
  const snapshot = JSON.parse(snapshotText ?? "{}") as Record<string, unknown>;
  for (const key of REQUIRED_SNAPSHOT_KEYS) {
    expect(Object.hasOwn(snapshot, key)).toBe(true);
  }

  const aliasText = await page.locator("#ai-context-sidecar").textContent();
  expect(aliasText).toBeTruthy();
  const aliasSnapshot = JSON.parse(aliasText ?? "{}") as Record<string, unknown>;
  for (const key of REQUIRED_SNAPSHOT_KEYS) {
    expect(Object.hasOwn(aliasSnapshot, key)).toBe(true);
  }

  const sessionId = await waitForSessionId(page);

  const markerBeforeReload = `pw_smoke_${Date.now().toString(36)}_before_reload`;
  await page.locator(".terminal-root").click();
  await page.keyboard.type(`echo ${markerBeforeReload}`);
  await page.keyboard.press("Enter");
  await page.keyboard.type("pwd");
  await page.keyboard.press("Enter");
  await waitForMarkerInRecentOutput(page, sessionId, markerBeforeReload);

  const reconnectReady = waitForNextSessionStreamReady(page, sessionId);
  await page.reload();
  const sessionIdAfterReload = await waitForSessionId(page);
  expect(sessionIdAfterReload).toBe(sessionId);
  await reconnectReady;

  const markerAfterReload = `pw_smoke_${Date.now().toString(36)}_after_reload`;
  await page.locator(".terminal-root").click();
  await page.keyboard.type(`echo ${markerAfterReload}`);
  await page.keyboard.press("Enter");
  await waitForMarkerInRecentOutput(page, sessionId, markerAfterReload);
});
