---
name: claude-delegate
description: Use when the user wants Claude Code to investigate, implement, or edit code from inside Codex.
---

# Claude Delegate

Use this skill when the user wants Claude to make changes in the current working tree.

Use the `bridge_delegate` MCP tool:

- `bridge_delegate` with `task` (required), `cwd`, and optionally `model`, `effort`, `resume`, `background`
- Example: `bridge_delegate` with `task: "fix the failing test"`, `model: "sonnet"`
- Example: `bridge_delegate` with `task: "finish follow-up work"`, `resume: "latest"`, `model: "opus"`
- Example: `bridge_delegate` with `task: "investigate the flaky test"`, `background: true`

Notes:

- If background mode is used, check `bridge_status`, `bridge_result`, and `bridge_cancel`
- Available models: sonnet (default for delegate), opus, haiku

Fallback (if MCP is unavailable):

- `node "$HOME/plugins/claude-bridge/scripts/claude-bridge.mjs" delegate --cwd "." --model sonnet "task"`
