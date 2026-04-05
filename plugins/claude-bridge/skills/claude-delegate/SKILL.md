---
name: claude-delegate
description: Use when the user wants Claude Code to investigate, implement, or edit code from inside Codex.
---

# Claude Delegate

Use this skill when the user wants Claude to make changes in the current working tree.

Run:

- `node "$HOME/plugins/claude-bridge/scripts/claude-bridge.mjs" delegate --cwd "." --model sonnet "fix the failing test"`
- `node "$HOME/plugins/claude-bridge/scripts/claude-bridge.mjs" delegate --cwd "." --model opus --resume latest "finish the follow-up work"`
- `node "$HOME/plugins/claude-bridge/scripts/claude-bridge.mjs" delegate --cwd "." --background "investigate the flaky test"`

Notes:

- Optional flags: `--model`, `--effort`, `--resume`, `--background`
- Trailing text becomes the delegate task
- If background mode is used, check `claude-status`, `claude-result`, and `claude-cancel`
