# Claude Bridge sidebar registrar (Mac side)

Registers finished conversations from the SSH host in the desktop app's private session store, targeting its regular Code-tab sidebar under the host and folder they ran in. The loader inspection supports this approach; actual sidebar display and resume still need verification on the Mac. Copying these files to the cluster does not install or run the Mac-side registrar.

Background and evidence: `desktop-sidebar-integration-findings.md` in this directory.

## How it works

1. Finds every repository with bridge jobs on the host: the bridge's registry under `~/.claude-bridge/repositories/` plus a bounded `find` for `.claude-bridge/jobs` directories under `~` (4 levels) and `/tmp` (2 levels), then runs the bridge's own catalog once per repo: `node <bridge>/plugins/claude-bridge/scripts/claude-bridge.mjs sessions --cwd <repo>`. The scan matters because repos that ran jobs before the bridge started registering them (and repos reached through a symlinked home) are missing from the registry. Change the scan with `--scan-root <path[:depth]>` or turn it off with `--no-scan`.
2. Checks, in one shell call on the host, that each session's transcript exists at `~/.claude/projects/<cwd-slug>/<sessionId>.jsonl` (the slug is also tried for the realpath of the folder).
3. Writes one `local_<sessionId>.json` per resumable conversation into the desktop store `~/Library/Application Support/Claude/claude-code-sessions/<account>/<org>/`, atomically, mode 0600.
4. Remembers what it wrote in `~/.claude-bridge/sidebar-registrar/state.json` (hash per record).

Rules that keep the desktop app's data safe:

- Only sessions the bridge reports as `resumable` (finished, with a saved session) are registered. Running jobs are skipped until they finish. Previously registered sessions remain in the app when the bridge resumes them; its session lock does not coordinate desktop writers. Continue a conversation from one side at a time.
- A record that already exists and was not written by the registrar is never touched. A record the registrar wrote but the app has since modified is never touched again.
- A `deleted_<sessionId>` tombstone (the user deleted it in the app) is final; the session is not re-created.
- Sessions under `/tmp` are included by default (Codex can resume them like any other); pass `--exclude-tmp` to leave the bridge's throwaway test runs out.

The desktop app loads the store once per launch, so new entries appear after **relaunching Claude**. The record format was read from Claude desktop 3.1623.0 and is private to the app; re-run the dry run after app updates and check the app log for `Failed to load session` lines if entries stop appearing.

Topic labels become title prefixes. Grouping uses the remote host and working directory; this does not create arbitrary named desktop projects or workspaces. SSH ports and identity-file settings are copied from the selected desktop connection. Each remote command has a 30-second timeout, and ownership state is saved after each written record.

## Usage

```bash
node registrar.mjs --dry-run --bridge-root /home/amkrtchyan/plugins/claude-bridge
```

```bash
node registrar.mjs --bridge-root /home/amkrtchyan/plugins/claude-bridge
```

Options: `--ssh-name <desktop ssh config name>`, `--ssh-alias <ssh host alias>`, `--scan-root <path[:depth]>` (repeatable), `--no-scan`, `--only <cwd>` (repeatable), `--exclude-tmp`, `--json`, `--account/--org`, `--state <file>`. `node registrar.mjs --help` lists them all.

Requirements: Node 18+ on the Mac, non-interactive `ssh <alias>` to the host (key in the agent or keychain), the desktop app signed in with the same SSH host saved in its SSH settings.

## Running it on a schedule

`com.claude-bridge.sidebar-registrar.plist` is a launchd template (every 10 minutes, and once at login). From this directory on the Mac, this installs the registrar under `~/.claude-bridge/sidebar-registrar/`, renders the template with your Node path, loads the agent and runs it once:

```bash
INST="$HOME/.claude-bridge/sidebar-registrar"; NODE="$(command -v node)"; PL="$HOME/Library/LaunchAgents/com.claude-bridge.sidebar-registrar.plist"; mkdir -p "$INST" "$HOME/Library/LaunchAgents" && cp registrar.mjs "$INST/" && sed -e "s#__NODE__#$NODE#g" -e "s#__NODE_DIR__#$(dirname "$NODE")#g" -e "s#__REGISTRAR_DIR__#$INST#g" -e "s#__HOME__#$HOME#g" com.claude-bridge.sidebar-registrar.plist > "$PL" && plutil -lint "$PL" && { launchctl bootout "gui/$(id -u)" "$PL" 2>/dev/null; launchctl bootstrap "gui/$(id -u)" "$PL"; } && launchctl kickstart -k "gui/$(id -u)/com.claude-bridge.sidebar-registrar"
```

Edit the `--bridge-root` and `--ssh-name` arguments in the template first if they differ from the defaults baked in there. Logs go to `~/.claude-bridge/sidebar-registrar/registrar.log` and `registrar.err`; `launchctl print gui/$(id -u)/com.claude-bridge.sidebar-registrar` shows the last exit code. The SSH key must be usable without a prompt from a launchd context (a keychain-backed key with `UseKeychain yes` in `~/.ssh/config` works). The scheduled pull writes records; it does not refresh or relaunch the desktop app. To uninstall: `launchctl bootout gui/$(id -u) "$PL"` and delete the plist.

## Tests

From the repository root, `npm test` includes these tests through `tests/sidebar-registrar.test.mjs`. To run only this directory:

```bash
node --test tools/sidebar-registrar/registrar.test.mjs
```

The integration fixture executes the catalog and transcript probe through a real shell, then checks dry-run behavior, record writes, repeat runs, edited records and deletion tombstones. It uses a temporary store without model requests or access to the live desktop store. These checks do not validate the desktop UI or native resume.

## Removing what it wrote

Delete the `local_<sessionId>.json` files listed in `state.json` from the store directory (or delete the sessions inside the app, which leaves tombstones the registrar respects), then delete `state.json`.
