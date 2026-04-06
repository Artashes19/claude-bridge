---
name: claude-status
description: Use when the user wants to see Claude Bridge jobs for the current repository.
---

# Claude Status

Use the `bridge_status` MCP tool:

- `bridge_status` with `cwd` set to the current working directory

Returns a list of all jobs (newest first) with their id, kind, status, model, and summary.

Fallback (if MCP is unavailable):

- `node "$HOME/plugins/claude-bridge/scripts/claude-bridge.mjs" status --cwd "."`
