---
name: claude-delegate
description: Use when the user wants Claude Code to investigate, implement, or edit code from inside Codex.
---

# Claude Delegate

Use this skill when the user wants Claude to make changes in the current working tree.

Call the `bridge_delegate` MCP tool with:
- `task` (required): the task description
- `cwd` set to the current working directory
- Optionally: `model` (sonnet/opus/haiku), `effort`, `resume`, `background`

Examples:
- `bridge_delegate` with `task: "fix the failing test"`, `model: "sonnet"`
- `bridge_delegate` with `task: "finish follow-up work"`, `resume: "latest"`, `model: "opus"`
- `bridge_delegate` with `task: "investigate the flaky test"`, `background: true`

If background mode is used, check `bridge_status`, `bridge_result`, and `bridge_cancel`.

Do NOT run shell commands — use the MCP tool which runs on the host with full authentication.
