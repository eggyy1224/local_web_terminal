---
name: tmux-pane-bridge
description: Communicate with another tmux pane (including 隔壁 pane) or another CLI/agent running in a different pane by listing panes, picking a target, capturing scrollback, sending keys/text, and verifying effects. Use when you need to interact with a process you are not currently focused on (e.g. send a prompt to another agent, type into a CLI form, press Enter/escape-submit, or copy the other pane's output).
---

# tmux Pane Bridge

## Migration Note

The previous wrapper script (`scripts/tmux_pane_bridge.py`) has been removed.
Use native `tmux` commands directly.

Legacy to native command mapping:

- `python3 scripts/tmux_pane_bridge.py here`
  -> `tmux display-message -p '#{session_name}:#{window_index}.#{pane_index} (pane_id=#{pane_id} tty=#{pane_tty})'`
- `python3 scripts/tmux_pane_bridge.py list`
  -> `tmux list-panes -a -F '#{session_name}:#{window_index}.#{pane_index} active=#{pane_active} pid=#{pane_pid} tty=#{pane_tty} cmd=#{pane_current_command} path=#{pane_current_path}'`
- `python3 scripts/tmux_pane_bridge.py capture --target 13:1.2 --lines 200`
  -> `tmux capture-pane -p -t 13:1.2 -S -200`
- `python3 scripts/tmux_pane_bridge.py send --target 13:1.2 --text 'ping' --submit enter --confirm-lines 80`
  -> `tmux send-keys -t 13:1.2 'ping' Enter` then `tmux capture-pane -p -t 13:1.2 -S -80`

## Quick Start

Identify where you are (active pane):

```bash
tmux display-message -p '#{session_name}:#{window_index}.#{pane_index} (pane_id=#{pane_id} tty=#{pane_tty})'
```

List panes (so you can select a precise target):

```bash
tmux list-panes -a -F '#{session_name}:#{window_index}.#{pane_index} active=#{pane_active} pid=#{pane_pid} tty=#{pane_tty} cmd=#{pane_current_command} path=#{pane_current_path}'
```

Capture the last N lines from the target pane:

```bash
tmux capture-pane -p -t 13:1.2 -S -200
```

Send text to the target and submit it:

```bash
tmux send-keys -t 13:1.2 'ping-from-tmux' Enter
```

Confirm result by capturing again:

```bash
tmux capture-pane -p -t 13:1.2 -S -80
```

## Neighbor Selection (Safe Flow)

Do not assume a missing neighbor falls back to the current pane.
Use this flow:

1) Capture your current pane metadata:

```bash
tmux display-message -p 'here=#{session_name}:#{window_index}.#{pane_index} id=#{pane_id}'
```

2) Try directional move and check command success:

```bash
tmux select-pane -R
```

If this command fails, stop immediately and report "no neighbor in that direction".

3) Read target pane identity after successful move:

```bash
tmux display-message -p 'neighbor=#{session_name}:#{window_index}.#{pane_index} id=#{pane_id}'
```

4) Return to the original pane by pane id:

```bash
tmux select-pane -t %44
```

Use the `id` from step 1 for the return target.

## Reliable Submit Keys

Different CLIs require different submit keys.
Use the key sequence that matches the target program:

- `enter`
```bash
tmux send-keys -t 13:1.2 'hello' Enter
```
- `double-enter`
```bash
tmux send-keys -t 13:1.2 'hello' Enter Enter
```
- `esc-enter`
```bash
tmux send-keys -t 13:1.2 'hello' Escape Enter
```
- `ctrl-d` (EOF; only when intended)
```bash
tmux send-keys -t 13:1.2 'hello' C-d
```

For target syntax and key names, see `references/targets-and-keys.md`.

## Safety Checklist

When interacting with another pane, prioritize not breaking the user's session:

- Always capture before and after sending keys.
- Prefer full targets like `session:window.pane` (for example `13:1.2`).
- Keep default actions non-destructive.
- Avoid `C-c`, `C-d`, `kill-pane`, or shell commands unless explicitly requested.
