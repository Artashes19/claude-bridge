---
name: claude-setup
description: Use when the user wants to verify that Claude Bridge can run the local Claude CLI with the current repo's read-only review defaults.
---

# Claude Setup

Use the `bridge_setup` MCP tool:

- `bridge_setup` with `cwd` set to the current working directory

Expect the result to show `ready: true` when Claude Code is installed, authenticated, and the working directory is a Git repo. If `ready: false`, check the `error` field for details.

Fallback (if MCP is unavailable):

- `node "$HOME/plugins/claude-bridge/scripts/claude-bridge.mjs" setup --cwd "."`
