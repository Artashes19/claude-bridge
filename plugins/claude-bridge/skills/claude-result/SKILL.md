---
name: claude-result
description: Use when the user wants the stored output for a Claude Bridge job.
---

# Claude Result

Use the `bridge_result` MCP tool:

- `bridge_result` with `jobId` (required, or "latest") and optionally `cwd`

Returns the full output of the job, plus diagnostics if the job failed.

Fallback (if MCP is unavailable):

- `node "$HOME/plugins/claude-bridge/scripts/claude-bridge.mjs" result --cwd "." --job-id latest`
