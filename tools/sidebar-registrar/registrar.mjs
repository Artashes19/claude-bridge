#!/usr/bin/env node
// Claude Bridge sidebar registrar (Mac side).
//
// Reads the bridge's session catalog on the SSH host and writes SSH session
// records into the Claude desktop app's private session store so that bridge
// conversations show up in the regular Code-tab sidebar. The desktop app reads
// that store once per launch, so new entries appear after the next relaunch.
//
// The store format was read from Claude desktop 3.1623.0 and is not a public
// API. The registrar only ever CREATES records it owns, or rewrites a record
// that is still byte-identical to what it wrote last time. Anything the app or
// the user has touched is left alone, and a `deleted_<uuid>` tombstone is final.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const REGISTRAR_VERSION = "0.1.0";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
const PERMISSION_MODE_BY_KIND = { delegate: "acceptEdits", review: "plan", discuss: "plan" };

// ---------- pure helpers ----------

/** Claude Code's project-directory slug for a working directory. */
export function slugForCwd(cwd) {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

export function toMs(value, fallback) {
  const ms = typeof value === "number" ? value : Date.parse(value ?? "");
  return Number.isFinite(ms) ? ms : fallback;
}

export function sessionTitle(session) {
  const base = session.title?.trim() || `Bridge ${session.kind ?? "job"} ${session.jobId ?? ""}`.trim();
  const title = session.project ? `${session.project} · ${base}` : base;
  return title.replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").slice(0, 200);
}

/** Build the desktop session record for one catalog session. */
export function buildRecord({ session, sshHost, sshConfig, transcriptPath, transcriptMtimeMs, now = Date.now() }) {
  if (!UUID.test(session.sessionId)) throw new Error(`Session id is not a UUID: ${session.sessionId}`);
  const createdAt = toMs(session.createdAt, now);
  const lastActivityAt = Math.max(createdAt, toMs(transcriptMtimeMs, createdAt));
  const record = {
    sessionId: `local_${session.sessionId}`,
    cliSessionId: session.sessionId,
    cwd: session.cwd,
    originCwd: session.cwd,
    createdAt,
    lastActivityAt,
    lastFocusedAt: createdAt,
    isArchived: false,
    title: sessionTitle(session),
    titleSource: session.title ? "user" : "auto",
    permissionMode: PERMISSION_MODE_BY_KIND[session.kind] ?? "default",
    sshConfig: { sshHost: sshConfig?.sshHost ?? sshHost },
    sshRemoteTranscriptPath: transcriptPath,
    completedTurns: 0,
    alwaysAllowedReasons: [],
    sessionPermissionUpdates: [],
  };
  for (const key of ["sshPort", "sshIdentityFile"]) {
    if (sshConfig?.[key] !== undefined) record.sshConfig[key] = sshConfig[key];
  }
  if (typeof session.model === "string" && session.model.startsWith("claude-")) record.model = session.model;
  if (EFFORTS.has(session.effort)) record.effort = session.effort;
  return record;
}

export function hashText(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

/**
 * Decide what to do for each catalog session given the current store contents.
 * `store` abstracts the filesystem so this stays testable.
 */
export function planActions({ sessions, store, state, sshHost, sshConfig, now = Date.now() }) {
  const actions = [];
  for (const session of sessions) {
    const id = session.sessionId;
    const reason = (why) => actions.push({ kind: "skip", sessionId: id, why });
    if (!UUID.test(id ?? "")) { reason("session id is not a UUID"); continue; }
    if (!session.resumable) { reason(`not resumable yet (status ${session.status})`); continue; }
    if (!session.transcript) { reason("transcript not found on host"); continue; }
    if (store.hasTombstone(id)) { reason("desktop deleted this session (tombstone present)"); continue; }
    const record = buildRecord({ session, sshHost, sshConfig, transcriptPath: session.transcript.path,
      transcriptMtimeMs: session.transcript.mtimeMs, now });
    const text = JSON.stringify(record, null, 2);
    const existing = store.readRecord(id);
    const owned = state.records?.[id];
    if (existing === null) {
      actions.push({ kind: "create", sessionId: id, text, record });
      continue;
    }
    if (!owned) { reason("record exists and was not written by the registrar"); continue; }
    if (hashText(existing) !== owned.hash) { reason("record was modified by the desktop app; left alone"); continue; }
    if (existing === text) { reason("up to date"); continue; }
    actions.push({ kind: "update", sessionId: id, text, record });
  }
  return actions;
}

// ---------- filesystem store ----------

export function makeStore(storeDir) {
  return {
    dir: storeDir,
    recordPath: (id) => path.join(storeDir, `local_${id}.json`),
    hasTombstone: (id) => fs.existsSync(path.join(storeDir, `deleted_${id}`)),
    readRecord(id) {
      try { return fs.readFileSync(this.recordPath(id), "utf8"); }
      catch (error) { if (error.code === "ENOENT") return null; throw error; }
    },
    writeRecord(id, text) {
      const target = this.recordPath(id);
      // The app only loads files named local_*.json, so a dot-prefixed temp name is invisible to it.
      const temporary = path.join(storeDir, `.registrar-${id}-${process.pid}.tmp`);
      fs.writeFileSync(temporary, text, { mode: 0o600 });
      try { fs.renameSync(temporary, target); }
      finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
    },
  };
}

export function loadState(statePath) {
  try { return JSON.parse(fs.readFileSync(statePath, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return { version: 1, records: {} }; throw error; }
}

export function saveState(statePath, state) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true, mode: 0o700 });
  const temporary = `${statePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(temporary, statePath);
}

// ---------- desktop app discovery (Mac side) ----------

export function desktopUserData(home = os.homedir()) {
  return path.join(home, "Library", "Application Support", "Claude");
}

export function resolveStoreDir({ userData, account, org }) {
  const root = path.join(userData, "claude-code-sessions");
  if (!account) {
    try { account = JSON.parse(fs.readFileSync(path.join(userData, "config.json"), "utf8")).lastKnownAccountUuid; }
    catch { /* fall through */ }
  }
  if (!account) throw new Error("Cannot determine the desktop account; pass --account <uuid>.");
  if (!org) {
    const orgs = fs.readdirSync(path.join(root, account), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && UUID.test(entry.name)).map((entry) => entry.name);
    if (orgs.length !== 1) throw new Error(`Expected one org dir under ${path.join(root, account)}, found ${orgs.length}; pass --org <uuid>.`);
    org = orgs[0];
  }
  return { account, org, storeDir: path.join(root, account, org) };
}

export function resolveSshHost({ userData, name }) {
  const { configs = [] } = JSON.parse(fs.readFileSync(path.join(userData, "ssh_configs.json"), "utf8"));
  const config = name ? configs.find((entry) => entry.name === name) : configs.length === 1 ? configs[0] : undefined;
  if (!config) throw new Error(`No desktop SSH config ${name ? `named ${JSON.stringify(name)}` : "(several exist; pass --ssh-name)"}.`);
  return config;
}

// ---------- remote side (over ssh) ----------

export function runSsh({ ssh, alias, command, input, timeoutMs = 30_000 }) {
  const result = spawnSync(ssh, ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", alias, command],
    { encoding: "utf8", input, maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs });
  if (result.error) throw new Error(`Remote command failed: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`ssh ${alias} failed (${result.status ?? result.signal}): ${(result.stderr ?? "").trim()}`);
  return result.stdout;
}

const shellQuote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

// Expand only the remote home prefix; keep the rest of the path literal.
const remotePath = (value) => value.startsWith("~/") ? `"$HOME"/${shellQuote(value.slice(2))}` : shellQuote(value);

export function fetchCatalog({ ssh, alias, bridgeScript, bridgeRoot }) {
  const command = `node ${remotePath(bridgeScript)} sessions --all-repositories --cwd ${remotePath(bridgeRoot)}`;
  const catalog = JSON.parse(runSsh({ ssh, alias, command }));
  if (!Array.isArray(catalog.sessions)) throw new Error("Unexpected catalog output: no sessions array.");
  return catalog;
}

/** One remote shell call: resolve $HOME, then stat each candidate transcript path. */
export const TRANSCRIPT_PROBE = String.raw`
home="$HOME"; echo "HOME	$home"
while IFS="	" read -r id cwd; do
  [ -n "$id" ] || continue
  rp=$(realpath -e -- "$cwd" 2>/dev/null || printf '%s' "$cwd")
  for c in "$cwd" "$rp"; do
    slug=$(printf '%s' "$c" | sed 's/[^a-zA-Z0-9]/-/g')
    f="$home/.claude/projects/$slug/$id.jsonl"
    if [ -f "$f" ]; then m=$(stat -c %Y -- "$f" 2>/dev/null || stat -f %m -- "$f"); echo "$id	$f	$m"; break; fi
  done
done`;

export function parseProbe(output) {
  const found = new Map();
  let home;
  for (const line of output.split("\n")) {
    const [a, b, c] = line.split("\t");
    if (a === "HOME") home = b;
    else if (a && b && c) found.set(a, { path: b, mtimeMs: Number(c) * 1000 });
  }
  return { home, found };
}

export function probeTranscripts({ ssh, alias, sessions }) {
  // Script on the command line, data on stdin: the two must never share a stream.
  const input = sessions.map((session) => `${session.sessionId}\t${session.cwd}`).join("\n") + "\n";
  return parseProbe(runSsh({ ssh, alias, command: `sh -c ${shellQuote(TRANSCRIPT_PROBE)}`, input }));
}

// ---------- CLI ----------

export function parseArgs(argv) {
  const options = { dryRun: false, json: false, includeTmp: false, only: [], ssh: "ssh",
    bridgeRoot: "~/plugins/claude-bridge" };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i], next = () => argv[++i];
    switch (arg) {
      case "--dry-run": options.dryRun = true; break;
      case "--json": options.json = true; break;
      case "--include-tmp": options.includeTmp = true; break;
      case "--only": options.only.push(next()); break;
      case "--ssh-alias": options.sshAlias = next(); break;
      case "--ssh-name": options.sshName = next(); break;
      case "--ssh-bin": options.ssh = next(); break;
      case "--bridge-root": options.bridgeRoot = next(); break;
      case "--bridge-script": options.bridgeScript = next(); break;
      case "--account": options.account = next(); break;
      case "--org": options.org = next(); break;
      case "--state": options.statePath = next(); break;
      case "--user-data": options.userData = next(); break;
      case "-h": case "--help": options.help = true; break;
      default: throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

export const USAGE = `Usage: node registrar.mjs [options]

Writes Claude Bridge sessions from the SSH host into the Claude desktop app's
session store so they appear in the Code-tab sidebar after the next relaunch.

  --dry-run             Show what would be written; change nothing
  --json                Machine-readable report
  --ssh-name <name>     Desktop SSH config name (default: the only one)
  --ssh-alias <alias>   ssh(1) host alias to connect with (default: the config name)
  --bridge-root <path>  Bridge checkout on the host (default: ~/plugins/claude-bridge)
  --bridge-script <p>   claude-bridge.mjs on the host (default: <root>/plugins/claude-bridge/scripts/claude-bridge.mjs)
  --only <cwd>          Only register sessions whose cwd equals this (repeatable)
  --include-tmp         Also register sessions whose cwd is under /tmp
  --account/--org <id>  Desktop account / org (default: detected)
  --state <file>        Registrar state (default: ~/.claude-bridge/sidebar-registrar/state.json)
`;

export function selectSessions(catalog, options) {
  return catalog.sessions.filter((session) => {
    if (options.only.length > 0 && !options.only.includes(session.cwd)) return false;
    if (!options.includeTmp && /^\/(?:private\/)?tmp\//.test(session.cwd ?? "")) return false;
    return true;
  });
}

export async function main(argv = process.argv.slice(2), io = { log: console.log, error: console.error }) {
  const options = parseArgs(argv);
  if (options.help) { io.log(USAGE); return 0; }
  const userData = options.userData ?? desktopUserData();
  const { account, org, storeDir } = resolveStoreDir({ userData, account: options.account, org: options.org });
  const sshConfig = resolveSshHost({ userData, name: options.sshName });
  const alias = options.sshAlias ?? sshConfig.name;
  const bridgeRoot = options.bridgeRoot;
  const bridgeScript = options.bridgeScript ?? `${bridgeRoot.replace(/\/+$/, "")}/plugins/claude-bridge/scripts/claude-bridge.mjs`;
  const statePath = options.statePath ?? path.join(os.homedir(), ".claude-bridge", "sidebar-registrar", "state.json");

  const catalog = fetchCatalog({ ssh: options.ssh, alias, bridgeScript, bridgeRoot });
  const candidates = selectSessions(catalog, options);
  const { found } = probeTranscripts({ ssh: options.ssh, alias, sessions: candidates });
  const sessions = candidates.map((session) => ({ ...session, transcript: found.get(session.sessionId) ?? null }));

  const store = makeStore(storeDir);
  const state = loadState(statePath);
  const actions = planActions({ sessions, store, state, sshConfig });

  let written = 0;
  if (!options.dryRun) {
    for (const action of actions) {
      if (action.kind !== "create" && action.kind !== "update") continue;
      store.writeRecord(action.sessionId, action.text);
      state.records ??= {};
      state.records[action.sessionId] = { hash: hashText(action.text), writtenAt: new Date().toISOString(),
        registrarVersion: REGISTRAR_VERSION, cwd: action.record.cwd, title: action.record.title };
      written++;
      saveState(statePath, state);
    }
  }

  const report = { account, org, storeDir, sshHost: sshConfig.sshHost, dryRun: options.dryRun,
    catalogSessions: catalog.sessions.length, considered: sessions.length, written,
    actions: actions.map(({ text, record, ...rest }) => ({ ...rest, ...(record ? { title: record.title, cwd: record.cwd } : {}) })),
    warnings: [...new Set(catalog.warnings ?? [])] };
  if (options.json) { io.log(JSON.stringify(report, null, 2)); return 0; }
  io.log(`Store: ${storeDir}`);
  io.log(`Host:  ${sshConfig.sshHost} (ssh alias ${alias}); catalog has ${catalog.sessions.length} session(s), ${sessions.length} considered`);
  for (const action of report.actions) {
    io.log(action.kind === "skip" ? `  skip   ${action.sessionId}  ${action.why}` :
      `  ${action.kind.padEnd(6)} ${action.sessionId}  ${action.title}  (${action.cwd})`);
  }
  io.log(options.dryRun ? "Dry run: nothing written." : `${written} record(s) written.${written ? " Relaunch Claude desktop to see them in the sidebar." : ""}`);
  for (const warning of report.warnings) io.error(`warning: ${warning}`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => process.exit(code), (error) => { console.error(error.message); process.exit(1); });
}
