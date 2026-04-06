---
name: claude-setup
description: Use when the user wants to verify that Claude Bridge can run the local Claude CLI with the current repo's read-only review defaults.
---

# Claude Setup

Run:

- `node "$HOME/plugins/claude-bridge/scripts/claude-bridge.mjs" setup --cwd "."`

Expect `READY: yes` only when Claude Code is installed, its version is reported, and the current repo's read-only review defaults in `--cwd` can execute a minimal probe. If the output shows `READY: no` and mentions `Not logged in · Please run /login`, authenticate Claude Code and rerun the command in that repo.
