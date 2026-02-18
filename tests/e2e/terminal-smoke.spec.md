# E2E Smoke (Playwright placeholder)

1. Open web app and verify only terminal is rendered.
2. Create or resume a session and run `pwd`.
3. Verify command output appears in terminal stream.
4. Verify sidecar exists and includes `sessionId`, `cwd`, `shell`, `recentOutput`, `lastCommands`.
5. Reload page and verify reconnect behavior still works.
