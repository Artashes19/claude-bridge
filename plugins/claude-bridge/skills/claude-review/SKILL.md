---
name: claude-review
description: Use when the user wants Claude Code to perform a read-only review of the current repository state from inside Codex.
---

# Claude Review

Use this skill when the user wants findings, not edits.

Run:

- `node "$HOME/plugins/claude-bridge/scripts/claude-bridge.mjs" review --cwd "." --model opus`
- `node "$HOME/plugins/claude-bridge/scripts/claude-bridge.mjs" review --cwd "." --base main --model sonnet`
- `node "$HOME/plugins/claude-bridge/scripts/claude-bridge.mjs" review --cwd "." --background "look for missing tests"`

Notes:

- Optional flags: `--base`, `--model`, `--effort`, `--background`
- Trailing text becomes the review focus
- If background mode is used, check `claude-status` and `claude-result`
