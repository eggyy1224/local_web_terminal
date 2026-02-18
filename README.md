# Local Web Terminal (iTerm2-like)

A local-first web terminal that runs on macOS and connects to your local shell environment via tmux + PTY. The UI is browser-hosted and exposes a structured sidecar context for AI collaboration.

## Features

- Browser terminal with xterm.js
- tmux-backed tabs and pane splits
- WebSocket shell streaming
- AI command proposal -> human confirm -> execute
- Sensitive output masking
- Local-only security model (`127.0.0.1` + Origin allowlist)
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

## Env

- `GATEWAY_PORT` default `8787`
- `ORIGIN_WHITELIST` default `http://127.0.0.1:5173,http://localhost:5173`
- `TMUX_BIN` default `tmux`
- `VITE_GATEWAY_BASE` default `http://127.0.0.1:8787`

## macOS note (node-pty)

On some macOS environments, `node-pty` ships `spawn-helper` without executable permission, which causes `posix_spawnp failed`.
This repo includes a `postinstall` hook that applies `chmod +x` automatically.

## APIs

- `POST /api/sessions`
- `POST /api/sessions/:id/tabs`
- `POST /api/sessions/:id/panes/split`
- `POST /api/commands/propose`
- `POST /api/commands/:proposalId/confirm`
- `GET /api/context/:id`
- `GET /api/sessions/:id/topology`
- `GET /api/health`
- `WS /ws/sessions/:id/stream`

## Security Notes

This project intentionally does not use auth tokens. To reduce abuse surface:

- Gateway binds only `127.0.0.1`
- CORS/Origin allowlist is enforced
- AI cannot execute commands without explicit confirm
- Explicit delete commands (`rm`, `rmdir`, `unlink`) are marked risky

## Current parity stage

Implemented: Phase A base with substantial Phase B scaffolding.

- tabs/panes/splits
- reconnect flow
- shortcut mappings (`Cmd+T`, `Cmd+D`, `Cmd+Shift+D`, `Cmd+F`)
- AI proposal/confirm panel
- context sidecar JSON (`#ai-context-sidecar`)
