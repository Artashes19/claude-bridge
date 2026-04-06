---
name: claude-setup
description: Use when the user wants to verify that Claude Bridge can run the local Claude CLI with the current repo's read-only review defaults.
---

# Claude Setup

Run:

- `node "$HOME/plugins/claude-bridge/scripts/claude-bridge.mjs" setup --cwd "."`

Expect `READY: yes` only when `--cwd` is inside a Git repo, Claude Code is installed, its version is reported, and the current repo's read-only review defaults in `--cwd` can execute a minimal probe. If the output shows `READY: no`, fix the repo/auth state and rerun the command in that repo.
