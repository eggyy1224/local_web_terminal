# tmux targets and keys

## Common target forms

- `session:window.pane` (recommended): `13:1.2`
- `pane_id`: `%44`

`tmux send-keys -t <target> ...` and `tmux capture-pane -t <target> ...` accept both forms.

## Common key names for `tmux send-keys`

- `Enter`
- `Escape`
- `C-c` (interrupt; avoid unless intended)
- `C-d` (EOF; avoid unless intended)

