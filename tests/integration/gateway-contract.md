# Integration Checklist

- `POST /api/sessions` returns `sessionId` and `activePaneId`.
- `GET /api/context/:id` returns masked output with minimal schema.
- `GET /api/health` returns service status.
- `WS /ws/sessions/:id/stream` supports `stdin` and `resize`.
- `WS /ws/sessions/:id/stream` emits `meta.kind=context_snapshot` on connect and during activity/heartbeat.
- `WS` rejects invalid client messages with `error` payload.
- Removed endpoints return 404 (`tabs`, `split`, `topology`, `focus-pane`, `commands/*`).
