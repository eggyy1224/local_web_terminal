# Local Web Terminal (Terminal-only)

A local-first web terminal for macOS that connects to your local shell via tmux + PTY.
The UI is intentionally minimal: one full-screen terminal with a read-only AI context sidecar.

## Features

- Single full-screen browser terminal (xterm.js)
- tmux-backed local shell session attach
- WebSocket shell streaming (`stdin` / `resize`)
- WebSocket context push (`meta.kind=context_snapshot`) with burst coalescing
- Read-only context sidecar for AI (`#snapshot-json`, alias: `#ai-context-sidecar`)
- Sensitive output masking
- Local-only security model (`127.0.0.1` + loopback origin allow)
- No disk persistence for session context

## Prerequisites

- Node.js LTS (>= 20)
- `tmux` installed and available in `PATH`
- macOS (first release target)

## Quick Start

```bash
npm install
npm run dev
```

Open [http://127.0.0.1:5173](http://127.0.0.1:5173)

Gateway runs on [http://127.0.0.1:8787](http://127.0.0.1:8787)

## Session Behavior

- Session binding is per browser tab (`sessionStorage` key: `local-web-terminal:session`)
- Reloading the same tab reuses its tmux session
- Opening a new tab creates a different tmux session by default
- Legacy shared `localStorage` session binding is no longer used

## Env

- `GATEWAY_PORT` default `8787`
- `ORIGIN_WHITELIST` default `http://127.0.0.1:5173,http://localhost:5173`
- `TMUX_BIN` default `tmux`
- `VITE_GATEWAY_BASE` default `http://127.0.0.1:8787`
- `CONTEXT_PUSH_DEBOUNCE_MS` default `300`
- `CONTEXT_PUSH_HEARTBEAT_MS` default `15000`
- `VITE_CONTEXT_BOOTSTRAP_TIMEOUT_MS` default `1500`
- `SESSION_TTL_MS` default `1800000`
- `SESSION_PRUNE_INTERVAL_MS` default `60000`

## macOS note (node-pty)

On some macOS environments, `node-pty` ships `spawn-helper` without executable permission, which causes `posix_spawnp failed`.
This repo includes a `postinstall` hook that applies `chmod +x` automatically.

## APIs

- `POST /api/sessions`
- `GET /api/context/:id`
- `GET /api/health`
- `WS /ws/sessions/:id/stream`

## Snapshot Contract

- Primary hidden snapshot node: `script#snapshot-json[type="application/json"]`
- Backward-compatible alias: `script#ai-context-sidecar[type="application/json"]`
- Refresh cadence: push-first over WS (`connect`, `stdout`, `submit`, `resize`, `heartbeat`)
- Bootstrap fallback: one-time HTTP context fetch if no initial WS snapshot arrives within `VITE_CONTEXT_BOOTSTRAP_TIMEOUT_MS`
- Required context fields:
  - `timestamp`
  - `cwd`
  - `repoRoot`
  - `branch`
  - `gitStatusPorcelain`
  - `diffStat`
  - `recentErrors`
  - `tmuxPanes`
  - `panes`

## Compatibility Notes

- `GET /api/context/:id` is retained for compatibility and diagnostics.
- `GET /__snapshot.json` is retained for sidecar/debug consumers.

## Breaking Changes

The following endpoints were removed:

- `POST /api/sessions/:id/tabs`
- `POST /api/sessions/:id/panes/split`
- `GET /api/sessions/:id/topology`
- `POST /api/sessions/:id/focus-pane`
- `POST /api/commands/propose`
- `POST /api/commands/:proposalId/confirm`

## Security Notes

- Gateway binds only `127.0.0.1`
- CORS/Origin allow is restricted to loopback origins
- AI context is read-only; no command execution API is exposed
