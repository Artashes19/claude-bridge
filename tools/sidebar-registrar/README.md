# Claude Bridge sidebar registrar (Mac side)

Makes Claude Bridge conversations that ran on the SSH host show up in the Claude desktop app's regular Code-tab sidebar, under the host and folder they ran in. Opening one resumes the cluster transcript through the app's own SSH daemon.

Background and evidence: `desktop-sidebar-integration-findings.md` in this directory.

## How it works

1. Runs the bridge's own catalog on the host: `node <bridge>/plugins/claude-bridge/scripts/claude-bridge.mjs sessions --all-repositories`.
2. Checks, in one shell call on the host, that each session's transcript exists at `~/.claude/projects/<cwd-slug>/<sessionId>.jsonl` (the slug is also tried for the realpath of the folder).
3. Writes one `local_<sessionId>.json` per resumable conversation into the desktop store `~/Library/Application Support/Claude/claude-code-sessions/<account>/<org>/`, atomically, mode 0600.
4. Remembers what it wrote in `~/.claude-bridge/sidebar-registrar/state.json` (hash per record).

Rules that keep the desktop app's data safe:

- Only sessions the bridge reports as `resumable` (finished, with a saved session) are registered. Running jobs hold the bridge's session lock and are skipped until they finish.
- A record that already exists and was not written by the registrar is never touched. A record the registrar wrote but the app has since modified is never touched again.
- A `deleted_<sessionId>` tombstone (the user deleted it in the app) is final; the session is not re-created.
- Sessions whose folder is under `/tmp` are skipped unless `--include-tmp` is given (the bridge's test runs live there).

The desktop app loads the store once per launch, so new entries appear after **relaunching Claude**. The record format was read from Claude desktop 3.1623.0 and is private to the app; re-run the dry run after app updates and check the app log for `Failed to load session` lines if entries stop appearing.

## Usage

```bash
node registrar.mjs --dry-run --bridge-root /home/amkrtchyan/plugins/claude-bridge
```

```bash
node registrar.mjs --bridge-root /home/amkrtchyan/plugins/claude-bridge
```

Options: `--ssh-name <desktop ssh config name>`, `--ssh-alias <ssh host alias>`, `--only <cwd>` (repeatable), `--include-tmp`, `--json`, `--account/--org`, `--state <file>`. `node registrar.mjs --help` lists them all.

Requirements: Node 18+ on the Mac, non-interactive `ssh <alias>` to the host (key in the agent or keychain), the desktop app signed in with the same SSH host saved in its SSH settings.

## Running it on a schedule

`com.claude-bridge.sidebar-registrar.plist` is a launchd template (every 10 minutes). Replace the two placeholders, copy it to `~/Library/LaunchAgents/`, and load it with `launchctl bootstrap gui/$(id -u) <plist>`.

## Tests

From the repository root, `npm test` includes these tests through `tests/sidebar-registrar.test.mjs`. To run only this directory:

```bash
node --test tools/sidebar-registrar/registrar.test.mjs
```

## Removing what it wrote

Delete the `local_<sessionId>.json` files listed in `state.json` from the store directory (or delete the sessions inside the app, which leaves tombstones the registrar respects), then delete `state.json`.
