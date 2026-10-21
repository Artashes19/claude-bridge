import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { slugForCwd, buildRecord, planActions, makeStore, hashText, parseProbe, parseArgs, selectSessions,
  resolveStoreDir, resolveSshHost, sessionTitle, main, runSsh } from "./registrar.mjs";

const SID = "b5e933d5-ff56-4dfb-9f93-7d2296c38ec8";
const session = (over = {}) => ({ sessionId: SID, jobId: "request-1", cwd: "/home/u/repo", kind: "discuss",
  status: "completed", resumable: true, model: "claude-fable-5-1", effort: "low", title: "Check", project: "Proj",
  createdAt: "2026-10-20T23:00:15.513Z",
  transcript: { path: "/home/u/.claude/projects/-home-u-repo/" + SID + ".jsonl", mtimeMs: 1760999000000 }, ...over });

test("slugForCwd matches Claude Code's project directory naming", () => {
  assert.equal(slugForCwd("/home/amkrtchyan/plugins/claude-bridge"), "-home-amkrtchyan-plugins-claude-bridge");
});

test("buildRecord produces an SSH session record the desktop loader understands", () => {
  const record = buildRecord({ session: session(), sshHost: "172.26.30.200", transcriptPath: "/t.jsonl", transcriptMtimeMs: 1760999000000 });
  assert.equal(record.sessionId, `local_${SID}`);
  assert.equal(record.cliSessionId, SID);
  assert.deepEqual(record.sshConfig, { sshHost: "172.26.30.200" });
  assert.equal(record.sshRemoteTranscriptPath, "/t.jsonl");
  assert.equal(record.permissionMode, "plan");
  assert.equal(record.model, "claude-fable-5-1");
  assert.equal(record.effort, "low");
  assert.equal(record.title, "Proj · Check");
  assert.equal(record.titleSource, "user");
  assert.equal(record.createdAt, Date.parse("2026-10-20T23:00:15.513Z"));
  assert.equal(record.lastActivityAt, 1760999000000 > record.createdAt ? 1760999000000 : record.createdAt);
  assert.equal(record.isArchived, false);
});

test("buildRecord drops alias models and unknown efforts, maps delegate to acceptEdits", () => {
  const record = buildRecord({ session: session({ model: "fable", effort: "turbo", kind: "delegate", title: null }),
    sshHost: "h", transcriptPath: "/t", transcriptMtimeMs: 0 });
  assert.equal(record.model, undefined);
  assert.equal(record.effort, undefined);
  assert.equal(record.permissionMode, "acceptEdits");
  assert.equal(record.titleSource, "auto");
  assert.equal(record.title, "Proj · Bridge delegate request-1");
});

test("sessionTitle strips control characters and caps length", () => {
  assert.equal(sessionTitle({ title: "a\u0000b   c", project: null }), "a b c");
  assert.equal(sessionTitle({ title: "x".repeat(500), project: null }).length, 200);
});

function fakeStore(files = {}, tombstones = []) {
  return { hasTombstone: (id) => tombstones.includes(id), readRecord: (id) => files[id] ?? null };
}

test("planActions creates a record for a resumable session with a transcript", () => {
  const actions = planActions({ sessions: [session()], store: fakeStore(), state: { records: {} }, sshHost: "h" });
  assert.equal(actions.length, 1);
  assert.equal(actions[0].kind, "create");
  assert.equal(JSON.parse(actions[0].text).cliSessionId, SID);
});

test("planActions skips running jobs, missing transcripts and tombstoned sessions", () => {
  const cases = [
    [session({ resumable: false, status: "running" }), /not resumable/],
    [session({ transcript: null }), /transcript not found/],
    [session({ sessionId: "not-a-uuid" }), /not a UUID/],
  ];
  for (const [s, why] of cases) {
    const [action] = planActions({ sessions: [s], store: fakeStore(), state: { records: {} }, sshHost: "h" });
    assert.equal(action.kind, "skip"); assert.match(action.why, why);
  }
  const [tomb] = planActions({ sessions: [session()], store: fakeStore({}, [SID]), state: { records: {} }, sshHost: "h" });
  assert.match(tomb.why, /tombstone/);
});

test("planActions never touches a record it did not write, or one the app changed", () => {
  const foreign = planActions({ sessions: [session()], store: fakeStore({ [SID]: "{}" }), state: { records: {} }, sshHost: "h" });
  assert.match(foreign[0].why, /not written by the registrar/);
  const changed = planActions({ sessions: [session()], store: fakeStore({ [SID]: "{\"edited\":true}" }),
    state: { records: { [SID]: { hash: hashText("{}") } } }, sshHost: "h" });
  assert.match(changed[0].why, /modified by the desktop app/);
});

test("planActions updates an owned, untouched record when catalog data changed, else reports up to date", () => {
  const first = planActions({ sessions: [session()], store: fakeStore(), state: { records: {} }, sshHost: "h" })[0];
  const state = { records: { [SID]: { hash: hashText(first.text) } } };
  const same = planActions({ sessions: [session()], store: fakeStore({ [SID]: first.text }), state, sshHost: "h" })[0];
  assert.equal(same.why, "up to date");
  const renamed = planActions({ sessions: [session({ title: "Renamed" })], store: fakeStore({ [SID]: first.text }), state, sshHost: "h" })[0];
  assert.equal(renamed.kind, "update");
  assert.equal(JSON.parse(renamed.text).title, "Proj · Renamed");
});

test("makeStore writes atomically with a temp name the app ignores, and sees tombstones", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "registrar-"));
  const store = makeStore(dir);
  store.writeRecord(SID, "{\"a\":1}");
  assert.equal(fs.readFileSync(path.join(dir, `local_${SID}.json`), "utf8"), "{\"a\":1}");
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith(".tmp")), []);
  assert.equal((fs.statSync(path.join(dir, `local_${SID}.json`)).mode & 0o777), 0o600);
  assert.equal(store.hasTombstone(SID), false);
  fs.writeFileSync(path.join(dir, `deleted_${SID}`), "");
  assert.equal(store.hasTombstone(SID), true);
});

test("parseProbe reads HOME and found transcripts", () => {
  const { home, found } = parseProbe(`HOME\t/home/u\n${SID}\t/home/u/.claude/projects/-home-u-repo/${SID}.jsonl\t1760999000\n\n`);
  assert.equal(home, "/home/u");
  assert.deepEqual(found.get(SID), { path: `/home/u/.claude/projects/-home-u-repo/${SID}.jsonl`, mtimeMs: 1760999000000 });
});

test("parseArgs and selectSessions honour --only and the /tmp filter", () => {
  const options = parseArgs(["--dry-run", "--only", "/home/u/repo", "--ssh-name", "cluster"]);
  assert.equal(options.dryRun, true); assert.equal(options.sshName, "cluster");
  const catalog = { sessions: [session(), session({ cwd: "/tmp/bridge-x" }), session({ cwd: "/home/u/other" })] };
  assert.deepEqual(selectSessions(catalog, options).map((s) => s.cwd), ["/home/u/repo"]);
  assert.deepEqual(selectSessions(catalog, parseArgs([])).map((s) => s.cwd), ["/home/u/repo", "/home/u/other"]);
  assert.equal(selectSessions(catalog, parseArgs(["--include-tmp"])).length, 3);
  assert.throws(() => parseArgs(["--bogus"]), /Unknown argument/);
});

test("resolveStoreDir and resolveSshHost read the desktop app's own config files", () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "userdata-"));
  const account = "685a13e9-afa2-430c-8671-090e504ea4c6", org = "9583b2c6-d500-41c5-899a-f9f574856eac";
  fs.mkdirSync(path.join(userData, "claude-code-sessions", account, org), { recursive: true });
  fs.writeFileSync(path.join(userData, "config.json"), JSON.stringify({ lastKnownAccountUuid: account }));
  fs.writeFileSync(path.join(userData, "ssh_configs.json"), JSON.stringify({ configs: [{ name: "cluster", sshHost: "1.2.3.4", id: "x" }] }));
  assert.deepEqual(resolveStoreDir({ userData }), { account, org, storeDir: path.join(userData, "claude-code-sessions", account, org) });
  assert.equal(resolveSshHost({ userData }).sshHost, "1.2.3.4");
  assert.equal(resolveSshHost({ userData, name: "cluster" }).name, "cluster");
  assert.throws(() => resolveSshHost({ userData, name: "nope" }), /No desktop SSH config/);
});

function integrationFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sidebar-integration-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const remoteHome = path.join(root, "remote home");
  const checkout = path.join(remoteHome, "checkout's directory");
  const script = path.join(checkout, "plugins/claude-bridge/scripts/claude-bridge.mjs");
  fs.mkdirSync(path.dirname(script), { recursive: true });
  const catalogSession = session({ cwd: checkout });
  fs.writeFileSync(script, `console.log(${JSON.stringify(JSON.stringify({ sessions: [catalogSession] }))});\n`);
  const transcript = path.join(remoteHome, ".claude/projects", slugForCwd(checkout), `${SID}.jsonl`);
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(transcript, "{}\n");
  const userData = path.join(root, "desktop");
  const account = "685a13e9-afa2-430c-8671-090e504ea4c6", org = "9583b2c6-d500-41c5-899a-f9f574856eac";
  const storeDir = path.join(userData, "claude-code-sessions", account, org);
  fs.mkdirSync(storeDir, { recursive: true });
  fs.writeFileSync(path.join(userData, "config.json"), JSON.stringify({ lastKnownAccountUuid: account }));
  const sshConfig = { name: "fixture", sshHost: "example.invalid", sshPort: 2222,
    sshIdentityFile: "/fixture/key", id: "config-only" };
  fs.writeFileSync(path.join(userData, "ssh_configs.json"), JSON.stringify({ configs: [sshConfig] }));
  const ssh = path.join(root, "fixture-ssh");
  fs.writeFileSync(ssh, `#!${process.execPath}
const { spawnSync } = require('node:child_process');
const result = spawnSync('sh', ['-c', process.argv.at(-1)], {
  encoding: 'utf8', timeout: 5000, input: require('node:fs').readFileSync(0),
  env: { ...process.env, HOME: ${JSON.stringify(remoteHome)} }
});
process.stdout.write(result.stdout ?? '');
process.stderr.write(result.stderr ?? '');
process.exit(result.status ?? 1);
`, { mode: 0o700 });
  const statePath = path.join(root, "state/state.json");
  const args = ["--user-data", userData, "--state", statePath, "--ssh-bin", ssh,
    "--bridge-root", "~/checkout's directory", "--include-tmp", "--json"];
  const recordPath = path.join(storeDir, `local_${SID}.json`);
  const run = async (...extra) => {
    let report;
    await main([...args, ...extra], { log: (text) => { report = JSON.parse(text); }, error: () => {} });
    return report;
  };
  return { run, recordPath, statePath, storeDir, transcript, sshConfig, root };
}

test("pull-and-write flow expands remote home, probes real transcripts and preserves SSH settings", async (t) => {
  const fixture = integrationFixture(t);
  const dry = await fixture.run("--dry-run");
  assert.equal(dry.actions[0].kind, "create");
  assert.equal(fs.existsSync(fixture.recordPath), false);
  assert.equal(fs.existsSync(fixture.statePath), false);
  const applied = await fixture.run();
  assert.equal(applied.written, 1);
  const record = JSON.parse(fs.readFileSync(fixture.recordPath, "utf8"));
  assert.deepEqual(record.sshConfig, { sshHost: fixture.sshConfig.sshHost,
    sshPort: 2222, sshIdentityFile: "/fixture/key" });
  assert.equal(record.sshRemoteTranscriptPath, fixture.transcript);
  const owned = JSON.parse(fs.readFileSync(fixture.statePath, "utf8")).records[SID];
  assert.equal(owned.hash, hashText(fs.readFileSync(fixture.recordPath, "utf8")));
  assert.equal((await fixture.run()).written, 0);
  fs.writeFileSync(fixture.recordPath, JSON.stringify({ ...record, title: "User title" }));
  assert.match((await fixture.run()).actions[0].why, /modified by the desktop app/);
  assert.equal(JSON.parse(fs.readFileSync(fixture.recordPath, "utf8")).title, "User title");
  fs.unlinkSync(fixture.recordPath);
  fs.writeFileSync(path.join(fixture.storeDir, `deleted_${SID}`), "");
  assert.match((await fixture.run()).actions[0].why, /tombstone/);
  assert.equal(fs.existsSync(fixture.recordPath), false);
});

test("remote commands terminate on timeout instead of hanging scheduled pulls", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sidebar-timeout-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ssh = path.join(root, "fixture-ssh");
  fs.writeFileSync(ssh, `#!${process.execPath}\nsetInterval(() => {}, 1000);\n`, { mode: 0o700 });
  assert.throws(() => runSsh({ ssh, alias: "fixture", command: "unused", timeoutMs: 100 }), /ETIMEDOUT/);
});
