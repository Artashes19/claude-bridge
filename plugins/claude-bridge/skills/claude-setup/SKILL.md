---
name: claude-setup
description: Use when the user wants to verify that Claude Bridge can find and run the local Claude CLI.
---

# Claude Setup

Run:

- `node "$HOME/plugins/claude-bridge/scripts/claude-bridge.mjs" setup --cwd "."`

Expect `READY: yes` only when Claude Code is installed, its version is reported, and a minimal read-only prompt probe succeeds. If the output shows `READY: no` and mentions `Not logged in · Please run /login`, authenticate Claude Code and rerun the command.
