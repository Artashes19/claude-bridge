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
- These examples assume the plugin has been installed to ~/plugins/claude-bridge.
- In `~/.agents/plugins/marketplace.json`, `./plugins/claude-bridge` resolves to `~/plugins/claude-bridge`.

## Commands Behind The Skills

- `node "$HOME/plugins/claude-bridge/scripts/claude-bridge.mjs" setup --cwd "."`
- `node "$HOME/plugins/claude-bridge/scripts/claude-bridge.mjs" review --cwd "." --model opus`
- `node "$HOME/plugins/claude-bridge/scripts/claude-bridge.mjs" delegate --cwd "." --model sonnet "fix the flaky test"`
- `node "$HOME/plugins/claude-bridge/scripts/claude-bridge.mjs" status --cwd "."`
- `node "$HOME/plugins/claude-bridge/scripts/claude-bridge.mjs" result --cwd "." --job-id latest`
- `node "$HOME/plugins/claude-bridge/scripts/claude-bridge.mjs" cancel --cwd "." --job-id latest`
