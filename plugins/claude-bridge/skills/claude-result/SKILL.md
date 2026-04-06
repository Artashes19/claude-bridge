---
name: claude-result
description: Use when the user wants the stored output for a Claude Bridge job.
---

# Claude Result

Call the `bridge_result` MCP tool with `jobId` (required, or "latest") and `cwd`.

Returns the full output of the job, plus diagnostics if the job failed.

Do NOT run shell commands — use the MCP tool.
