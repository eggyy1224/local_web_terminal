# Integration Checklist

- `POST /api/sessions` returns `sessionId` and `activePaneId`.
- `POST /api/sessions/:id/tabs` creates a new tmux window.
- `POST /api/sessions/:id/panes/split` creates pane and keeps stream alive.
- `POST /api/commands/propose` always returns proposal and preview.
- `POST /api/commands/:proposalId/confirm` executes via tmux send-keys only after confirm.
- `GET /api/context/:id` masks secrets in `recentOutput` and `lastCommands`.
- WebSocket `/ws/sessions/:id/stream` supports `stdin`, `resize`, `focus-pane`.
