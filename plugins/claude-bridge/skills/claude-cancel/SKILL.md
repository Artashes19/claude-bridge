---
name: claude-cancel
description: Use when the user wants to stop an active Claude Bridge background job.
---

# Claude Cancel

Use the `bridge_cancel` MCP tool:

- `bridge_cancel` with `jobId` (required, or "latest") and optionally `cwd`

Sends SIGTERM to the job's process group and marks it as canceled.

Fallback (if MCP is unavailable):

- `node "$HOME/plugins/claude-bridge/scripts/claude-bridge.mjs" cancel --cwd "." --job-id latest`
