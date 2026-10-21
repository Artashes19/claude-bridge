# Claude Bridge: regular desktop Code-tab sidebar integration

Investigation date: 2026-10-21. Desktop app 3.1623.0 (Claude.app, Electron bundle `app.asar`), pinned CLI 2.1.304 on the SSH host. Bridge repo: `cluster:/home/amkrtchyan/plugins/claude-bridge` (uncommitted work preserved, nothing modified). No model prompts were sent during this investigation.

## Verdict

The desktop app has **no external interface** for registering a session that runs on an SSH host. Every official entry point that creates a regular sidebar session either starts a *new* session (deep link, in-session tools, routines) or imports a *local* transcript only (resume picker, `claude://resume`, Settings history import). SSH transcripts are explicitly excluded from all import paths.

The one path that can make a bridge-run session appear in the regular sidebar, attached to its own cluster transcript, is **writing a session record into the app's private session store** on the Mac. The app loads that store once per launch, so a record written while the app is open shows up after the next relaunch (or sign-in/org re-init). Opening it then resumes the transcript on the cluster through the app's own SSH daemon with `--resume`. This is a private, undocumented format and will need re-validation when the app updates.

Remote Control is a separate surface and is correctly ruled out; nothing below depends on it.

## How the desktop app tracks Code-tab sessions

### Session store (the sidebar's source of truth)

- Path: `~/Library/Application Support/Claude/claude-code-sessions/<accountUuid>/<orgUuid>/local_<uuid>.json`
  - For this Mac: account `685a13e9-afa2-430c-8671-090e504ea4c6`, org `9583b2c6-d500-41c5-899a-f9f574856eac`.
  - Companion files in the same dir: `deleted_<uuid>` tombstones, `archived-sessions.idx`, `scheduled-tasks.json`, `waiting-input/`, `imported-staging/`.
- Loader: `LocalSessionManager.loadSessionRecords()` in `.vite/build/index.chunk-Cses962f.js`. It `readdir`s the dir, takes every `local_*.json`, skips files over 10 MB, `JSON.parse`s each one and hydrates it with `Oj()` in `index.chunk-XE4x008H.js`. Unknown fields are ignored; missing optional fields get defaults.
- **Load timing**: only from `initializeWithAccount()` (app launch, account change, org change, sign-out/sign-in). There is no filesystem watcher and no IPC to rescan. A record dropped in while the app runs is invisible until relaunch.
- There is a sibling-profile scan (`tB/aB`) that reads other profile roots for *ownership claims* only, not for display.

### Record shape for an SSH session (observed, real record `local_0a8390d4-…json`)

Fields the hydrator reads and that matter for an SSH session:

| field | notes |
|---|---|
| `sessionId` | `local_<uuid>`; must equal the file stem |
| `cliSessionId` | the CLI transcript UUID; what `--resume` receives |
| `cwd`, `originCwd` | absolute path **on the SSH host** |
| `sshConfig` | `{ "sshHost": "172.26.30.200" }` (optionally `sshPort`, `sshIdentityFile`); must match an entry in `ssh_configs.json` / trusted hosts |
| `sshRemoteTranscriptPath` | `/home/amkrtchyan/.claude/projects/<cwd-slug>/<cliSessionId>.jsonl`; the app derives `sshRemoteProjectDir` from it |
| `title`, `titleSource` | sidebar label |
| `model`, `effort`, `permissionMode` | used when respawning; `permissionMode` is validated (`VA(...)`), unknown values fall back to default |
| `createdAt`, `lastActivityAt`, `lastFocusedAt` | ms epoch; drive recency sort |
| `isArchived` | boolean |
| `sshReattach`, `sshRemoteProcessId` | only for reattaching to a daemon child that is still running; omit for a finished bridge job, the app then treats it as `processGoneReason: "app_relaunch"` and respawns on open |

Local-only sessions additionally carry `gitAnchorsFolderRealpath`, `envScopeId`, `promptAppendSnapshot`, `toolSurfaceSnapshot`; these are snapshots the app rewrites and are not required to load.

### SSH execution model

- The app installs a Go daemon on the host: `~/.claude/remote/srv/<hash>/server --serve --socket ~/.claude/remote/run/<clientRunId>/rpc.sock --token-file …`. Its RPC surface (from `index.chunk-ByVorCQZ.js`): `server.capabilities`, `server.ping`, `process.spawn`, `process.reattach`, `process.stdin`, `process.kill`, `process.killAndWait`, `files.read/list/stat/realpath/extract_tar`, `git.info/status/list_branches/worktree_create/worktree_remove`, `launcher.resolve`, `plugins.prune`. Wire format is newline-delimited JSON over the Unix socket with a per-run token (`daemon.token`). Clients are the desktop app only; there is no documented third-party client.
- The daemon spawns the pinned CLI `~/.claude/remote/ccd-cli/2.1.304-332dfee32f6f` with `--resume=<cliSessionId> --output-format stream-json --input-format stream-json --permission-prompt-tool=stdio …` in the session's `cwd` (observed via `ps` on the cluster). The CLI then reads `~/.claude/projects/<cwd-slug>/<cliSessionId>.jsonl` on the host.
- The app also keeps a local mirror of each SSH transcript under `~/.claude/projects/ssh-<uuid>/<uuid>.jsonl` on the Mac (used for search/export; import code excludes these dirs via `excludeSshDirs`).

### Official session-creation interfaces, and why each falls short

1. **Deep link `claude://code/new?ssh_host=<user@host>&ssh_port=&ssh_folder=<path>&q=<prompt>`** (`U3n`/`D5n` in `index.chunk-BLvpT1n4.js`). Official, documented. Creates a *new* SSH session in the sidebar on the Mac. Cannot point at an existing transcript. Must be fired on the Mac (`open "claude://…"`), so the cluster-side bridge needs a reverse channel. Whether `q` auto-submits could not be verified from the bundle (the Code tab UI is served remotely); docs say it does not.
2. **`claude://resume?session=<uuid>`** → `importCliSession` → `adoptCliSession` (`index.chunk-Cses962f.js`). Resolves the transcript in the **Mac's** `~/.claude/projects` only, requires the transcript's `cwd` to exist and be trusted locally, and spawns the local CLI. Telemetry hard-codes `is_ssh: false`. Not usable for cluster transcripts.
3. **Resume picker** (`listResumableCliSessions` / `resumeCliSession`, discovery in `index.chunk-VUUA83Ib.js`) and **Settings → history import** (`HistoryImport_$_importSessionSources`, source `terminal-cli`, `index.chunk-CANsNWOj.js`). Both enumerate local `~/.claude/projects` with `excludeSshDirs: true` and register via `registerExternalSession`, which writes a **local** record (no `sshConfig`). Local-only by construction.
4. **In-session tools** `mcp__ccd_session__start_session` with `target: "ssh"` / `host`, and **routines** (`scheduled-tasks.json` with an SSH `cwd`). Both produce proper sidebar sessions on the host, but each requires a model turn in the desktop app to trigger or run, so they are paid and not an integration API.
5. **`registerExternalSession` IPC** (used by 3). Takes `{sessionId, cliSessionId, cwd, title, transcriptStagingPath, importedFrom, …}` and requires the transcript to be staged inside the private `imported-staging` dir. It is reachable only from the renderer over Electron IPC, and it has no SSH variant.

## What the bridge already does that lines up

- Every job stores a UUID `sessionId` before execution and runs the CLI with `--session-id` / `--resume` (`plugins/claude-bridge/scripts/lib/claude.mjs`, `sessions.mjs`). Transcripts therefore land in `~/.claude/projects/<cwd-slug>/<sessionId>.jsonl` on the cluster, the exact location the desktop's `--resume` reads.
  - Verified on disk: `~/.claude/projects/-home-amkrtchyan-plugins-claude-bridge/b5e933d5-….jsonl` for job `request-a7016b…`.
- Job records (`.claude-bridge/jobs/*.json`, plus `~/.claude-bridge/repositories/`) already hold `cwd`, `sessionId`, `project`, `title`, model, effort, timestamps, status. That is everything a sidebar record needs.
- The bridge holds a `<sessionId>.session-lock` while a worker runs. The desktop would also take the transcript when a user opens the session; the two must not run at once.

## Recommended integration path

**Sidebar registrar on the Mac, writing records into the app's session store.**

1. A small Mac-side process (launchd agent, or a `node` script the user runs) connects to `cluster` over SSH and reads the bridge's job catalog (`bridge_sessions` already deduplicates resumed jobs into one conversation; its CLI equivalent is `claude-bridge.mjs sessions --all-repositories`).
2. For each conversation it does not yet know, it writes `local_<sessionId>.json` into `claude-code-sessions/<account>/<org>/` with the SSH record shape above (`sshConfig.sshHost` from `ssh_configs.json`, `cwd` = repo path on the cluster, `sshRemoteTranscriptPath` from the cluster home, `title` = bridge title or project label, `model`/`effort` from the job, `permissionMode` = `acceptEdits` for delegate / `plan` for review, timestamps from the job). Write atomically (temp file + rename). Use the job's own `sessionId` as the record stem so the two systems share one identity.
3. Skip conversations whose latest job is still `queued`/`running` (session lock held) or mark them `isArchived: true` until finished, so a user cannot open a transcript the bridge is mid-write on.
4. The record appears after the next app relaunch. Opening it makes the app spawn `ccd-cli --resume=<sessionId>` on the cluster; the conversation continues in the regular Code tab with the app's hooks and MCP tools.
5. Keep the registrar one-directional (bridge → sidebar). Desktop-side edits (title, archive, delete tombstone `deleted_<uuid>`) should be respected by never re-creating a record whose tombstone exists.

Costs and risks to state in the bridge README: the store format is private to the app and was read from version 3.1623.0; a relaunch is needed to see new entries; `homeTenancy` and permission-mode acknowledgements (`epitaxy-folder-permission-mode` in `claude_desktop_config.json`) are per folder, so a new cluster folder will prompt for trust/permission mode on first open.

**Alternative, if live visibility matters more than adopting bridge transcripts**: have the bridge delegate execution to the desktop by firing `claude://code/new?ssh_host=…&ssh_folder=…&q=…` on the Mac, then read the resulting transcript from the cluster projects dir. This is fully official, but the bridge loses control of the run (model, effort, permission mode, budget), needs a cluster→Mac trigger, and the `q` prompt likely still needs a human to press send.

## Not verified (deliberately, to preserve state and avoid paid runs)

- No record was injected into the live session store, and the app was not relaunched, so "appears after relaunch" is inferred from the loader code, not observed.
- Resuming a bridge-written transcript with the app's pinned CLI 2.1.304 was not executed. The bridge runs the Agent SDK 0.3.305 bundle; the transcript format is the same family, but a resume smoke test is the first thing to run once a test prompt is acceptable.
- The daemon's JSON-RPC handshake was identified but not exercised; a cluster-side `process.spawn` client is possible in principle but offers nothing the record path does not, because the sidebar still needs the Mac-side record.

## Evidence index

- Session store constants: `index.chunk-BLvpT1n4.js` (`_Ye="claude-code-sessions"`, `vYe="local_"`, `xYe="imported-staging"`, `SYe.terminalCli="terminal-cli"`).
- Loader and lifecycle: `index.chunk-Cses962f.js` `loadSessionRecords`, `loadSessions`; base `initializeWithAccount` in `index.chunk-XE4x008H.js`.
- Hydration: `index.chunk-XE4x008H.js` `Oj(e,n)`, `Hk(e,t)` (SSH cut-turn state).
- Import/recovery: `index.chunk-Cses962f.js` `Rz.adoptCliSession`, `registerExternalSession`, `finishRegisterExternalSession`; discovery `index.chunk-VUUA83Ib.js` `resolveForResume`; local-projects enumerator `pLi` with `excludeSshDirs` in `index.chunk-BLvpT1n4.js`.
- Deep links: `index.chunk-BLvpT1n4.js` route enum (`Al.Resume="resume"`), handler block near `claudeURLHandler`, SSH parser `U3n`, builder `D5n`.
- SSH daemon client: `index.chunk-ByVorCQZ.js` (`RemoteRPCClient`, `RemoteProcess.adoptOrSpawnHoldingSlot`, `RemoteServerController.queryServerCapabilities`).
- Live cluster state: daemon lock `~/.claude/remote/run/ff2b7d14/daemon.lock`, children `…/children/<pid>.json`, host facts in `~/Library/Application Support/Claude/ssh-remote-server-state.json`.
- Bridge: `plugins/claude-bridge/scripts/lib/{claude,sessions,session-recovery,viewer-state,visibility}.mjs`, README diff lines 42–56 (states that regular workspace integration is not implemented).
