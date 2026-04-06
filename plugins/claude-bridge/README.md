# Claude Bridge

Claude Bridge is a Codex plugin that shells out to the local `claude` CLI for:

- read-only review
- writable delegation
- status, result, and cancel for background runs

## Runtime

- Claude binary: discovered from `PATH` by default
- Repo-local state: `.claude-bridge/`
- Repo-local config: `.claude-bridge/config.json`
- Global config: `~/.claude-bridge/config.json`
- `setup --cwd <repo>` verifies that repo's read-only review defaults can actually run, using the resolved review model, default effort, and Claude auth state for that repo context
- `setup --cwd` should point at a Git repo; the bridge will not claim review readiness for a non-repo directory
- Claude Bridge bootstraps `.claude-bridge/` into that repo's local Git exclude file so runtime state stays untracked by default
- Read-only review input omits repo-local `.claude-bridge/` artifacts from the working-tree status text and only inlines small text untracked files; larger, binary, or unreadable untracked files are replaced with a note
- These examples assume the plugin has been installed to ~/plugins/claude-bridge.
- In `~/.agents/plugins/marketplace.json`, `./plugins/claude-bridge` resolves to `~/plugins/claude-bridge`.

## Publishing

This repo is structured so it can be pushed to GitHub and shared directly. After cloning, friends can install the plugin by copying `plugins/claude-bridge/` into `~/plugins/claude-bridge/` and registering the matching marketplace entry from `.agents/plugins/marketplace.json`.

## Commands Behind The Skills

- `node "$HOME/plugins/claude-bridge/scripts/claude-bridge.mjs" setup --cwd "."`
- `node "$HOME/plugins/claude-bridge/scripts/claude-bridge.mjs" review --cwd "." --model opus`
- `node "$HOME/plugins/claude-bridge/scripts/claude-bridge.mjs" delegate --cwd "." --model sonnet "fix the flaky test"`
- `node "$HOME/plugins/claude-bridge/scripts/claude-bridge.mjs" status --cwd "."`
- `node "$HOME/plugins/claude-bridge/scripts/claude-bridge.mjs" result --cwd "." --job-id latest`
- `node "$HOME/plugins/claude-bridge/scripts/claude-bridge.mjs" cancel --cwd "." --job-id latest`

For `setup`, `READY: yes` means Claude Bridge could run a minimal read-only review probe in the requested Git repo `--cwd` with that repo's current default review settings. `READY: no` with `Not logged in · Please run /login` means the Claude CLI is installed but cannot execute the probe until Claude Code is authenticated.
