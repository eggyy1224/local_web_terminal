# E2E Smoke (Playwright placeholder)

1. Open web app and verify only terminal is rendered.
2. Create or resume a session and run `pwd`.
3. Verify command output appears in terminal stream.
4. Verify hidden snapshot scripts exist (`#snapshot-json` + `#ai-context-sidecar`) and both are valid JSON.
5. Verify snapshot `context` includes `timestamp`, `cwd`, `repoRoot`, `branch`, `gitStatusPorcelain`, `diffStat`, `recentErrors`, `tmuxPanes`, `panes`.
6. Verify snapshot timestamp advances within 2 seconds after command submit (push path).
7. Reload page and verify reconnect behavior still works.
