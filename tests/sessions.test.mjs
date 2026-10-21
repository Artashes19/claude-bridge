import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { handleDelegate, handleTaskRequest, handleResult, handleStatus } from '../plugins/claude-bridge/scripts/lib/mcp-handlers.mjs';
import { prepareDelegateJob } from '../plugins/claude-bridge/scripts/lib/delegate.mjs';
import { DEFAULT_CONFIG } from '../plugins/claude-bridge/scripts/lib/config.mjs';
import { createProjector, recoverJournal, runStream } from '../plugins/claude-bridge/scripts/lib/stream.mjs';
import { lockSession } from '../plugins/claude-bridge/scripts/lib/sessions.mjs';
import { createJobRecord, writeJobRecord, readJobRecord } from '../plugins/claude-bridge/scripts/lib/jobs.mjs';
import { resolvePaths, ensureStateDirs } from '../plugins/claude-bridge/scripts/lib/paths.mjs';

function fixture(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-session-test-'));
  assert.equal(spawnSync('git', ['init', '-q', cwd]).status, 0);
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const paths = resolvePaths({ cwd, homeDir: cwd });
  ensureStateDirs(paths);
  return { cwd, paths };
}
const line = (event) => JSON.stringify(event);
const init = (sessionId) => ({ type: 'system', subtype: 'init', session_id: sessionId, model: 'resolved-model' });
const reply = (text, id = 'message-one') => ({ type: 'assistant', message: { id, content: [{ type: 'text', text }] } });
const done = { type: 'result', subtype: 'success', is_error: false, usage: { output_tokens: 5 }, total_cost_usd: 0.1 };

function saved(t, patch = {}) {
  const { cwd, paths } = fixture(t);
  const job = createJobRecord({ kind: 'discuss', cwd, summary: 'fixture', model: 'test-model', effort: 'xhigh' });
  Object.assign(job, { sessionId: '11111111-1111-4111-8111-111111111111', sessionReady: true,
    status: 'completed', outputFile: path.join(paths.outputDir, 'reply.txt'), finishedAt: new Date().toISOString(), ...patch });
  fs.writeFileSync(job.outputFile, 'saved reply');
  writeJobRecord({ jobsDir: paths.jobsDir, job });
  return { cwd, paths, job };
}

test('discussion follow-ups use the saved native session and inherit settings', (t) => {
  const { cwd, paths, job } = saved(t);
  const next = prepareDelegateJob({ cwd, paths, config: DEFAULT_CONFIG, taskText: 'Challenge the earlier conclusion.',
    resumeSpecifier: job.id, kind: 'discuss' });
  assert.equal(next.sessionId, job.sessionId);
  assert.equal(next.resumedFrom, job.id);
  assert.equal(next.request.args[next.request.args.indexOf('--resume') + 1], job.sessionId);
  assert.ok(!next.request.args.includes('--session-id'));
  assert.equal(next.request.prompt, 'Challenge the earlier conclusion.');
  assert.equal(next.request.args[next.request.args.indexOf('--tools') + 1], '');
  assert.equal(next.model, job.model);
  assert.equal(next.effort, 'xhigh');
  assert.deepEqual(next.settingsSource, { model: 'session', effort: 'session' });
  const overridden = prepareDelegateJob({ cwd, paths, config: DEFAULT_CONFIG, taskText: 'Another question',
    resumeSpecifier: job.id, requestedEffort: 'max', requestedModel: 'specific-model', maxBudgetUsd: 1, kind: 'discuss' });
  assert.equal(overridden.model, 'specific-model');
  assert.equal(overridden.effort, 'max');
  assert.equal(overridden.request.args[overridden.request.args.indexOf('--max-budget-usd') + 1], '1');
});

test('interrupted sessions are resumable while legacy reports fail explicitly', (t) => {
  const { cwd, paths, job } = saved(t, { status: 'failed' });
  assert.equal(prepareDelegateJob({ cwd, paths, config: DEFAULT_CONFIG, taskText: 'Continue.', resumeSpecifier: job.id }).sessionId, job.sessionId);
  writeJobRecord({ jobsDir: paths.jobsDir, job: { ...job, sessionId: null } });
  assert.throws(() => prepareDelegateJob({ cwd, paths, config: DEFAULT_CONFIG, taskText: 'Continue.', resumeSpecifier: job.id }), /Older report-only/);
});

test('one session accepts only one active writer and releases the lock afterwards', (t) => {
  const { paths, job } = saved(t);
  const unlock = lockSession({ jobsDir: paths.jobsDir, job });
  assert.throws(() => lockSession({ jobsDir: paths.jobsDir, job: { ...job, id: 'second' } }), /already in use/);
  unlock();
  lockSession({ jobsDir: paths.jobsDir, job })();
});

test('invalid effort and budgets fail before any execution', async (t) => {
  const { cwd } = fixture(t);
  let runs = 0;
  for (const options of [{ effort: 'automatic' }, { maxBudgetUsd: -1 }]) {
    const result = await handleTaskRequest(handleDelegate, { cwd, homeDir: cwd, task: 'fixture', ...options,
      deps: { spawnDetachedWorker: () => { runs++; } } });
    assert.ok(result.error);
  }
  assert.equal(runs, 0);
});

test('projection deduplicates complete replies, excludes nested messages and records usage', (t) => {
  const { paths } = fixture(t);
  const outputFile = path.join(paths.outputDir, 'reply.txt');
  const projector = createProjector({ outputFile });
  const events = [init('session-one'),
    { type: 'stream_event', event: { type: 'message_start', message: { id: 'message-one' } } },
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Հայերեն🛰️' } } },
    reply('Հայերեն🛰️'), { ...reply('nested'), parent_tool_use_id: 'nested-tool' }, done];
  for (const event of events) projector.consume(line(event));
  assert.equal(fs.readFileSync(outputFile, 'utf8'), 'Հայերեն🛰️');
  assert.equal(projector.state().progress.sessionCostUsd, 0.1);
  assert.equal(projector.state().progress.actualModel, 'resolved-model');
});

test('stream parser survives byte-split Unicode and saves raw events before projection', async (t) => {
  const { cwd, paths } = fixture(t);
  const events = [init('session-one'), reply('Հայերեն🛰️'), done];
  const raw = events.map(line).join('\n') + '\n';
  const args = ['-e', `const b=Buffer.from(${JSON.stringify(raw)}); for(let i=0;i<b.length;i++)process.stdout.write(b.subarray(i,i+1));`];
  const outputFile = path.join(paths.outputDir, 'reply.txt');
  const eventsFile = outputFile + '.jsonl';
  const result = await runStream({ binary: process.execPath, args, cwd, outputFile,
    stderrFile: outputFile + '.stderr', eventsFile, onProgress() {} });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, 'Հայերեն🛰️');
  assert.equal(fs.readFileSync(eventsFile, 'utf8'), raw);
  fs.unlinkSync(outputFile);
  recoverJournal({ eventsFile, outputFile });
  assert.equal(fs.readFileSync(outputFile, 'utf8'), result.stdout);
});

test('a stream missing its final result retains partial output and fails clearly', async (t) => {
  const { cwd, paths } = fixture(t);
  const outputFile = path.join(paths.outputDir, 'partial.txt');
  const result = await runStream({ binary: process.execPath,
    args: ['-e', `console.log(${JSON.stringify(line(reply('partial evidence')))});`], cwd, outputFile,
    stderrFile: outputFile + '.stderr', eventsFile: outputFile + '.jsonl', onProgress() {} });
  assert.equal(result.exitCode, 1);
  assert.equal(result.stdout, 'partial evidence');
  assert.match(result.error.message, /without a final result/);
});

test('budget errors preserve their report and usage even with exit zero', async (t) => {
  const { cwd, paths } = fixture(t);
  const outputFile = path.join(paths.outputDir, 'limit.txt');
  const event = { ...done, subtype: 'error_max_budget_usd', is_error: true, errors: ['Budget reached'], result: 'partial work' };
  const result = await runStream({ binary: process.execPath, args: ['-e', `console.log(${JSON.stringify(line(event))})`],
    cwd, outputFile, stderrFile: outputFile + '.stderr', eventsFile: outputFile + '.jsonl', onProgress() {} });
  assert.equal(result.exitCode, 1);
  assert.match(result.error.message, /Budget reached/);
  assert.equal(result.stdout, 'partial work');
});

test('reports stay pending until every page is received and explicitly acknowledged', async (t) => {
  const { cwd, paths, job } = saved(t);
  const options = { cwd, homeDir: cwd, jobId: job.id };
  const first = await handleResult({ ...options, maxBytes: 4 });
  assert.equal(first.delivery.fullyRetrieved, false);
  const invalid = await handleResult({ ...options, offset: 100, acknowledge: true });
  assert.match(invalid.error, /every report page/);
  assert.ok((await handleStatus(options)).pendingReports.includes(job.id));
  const final = await handleResult({ ...options, offset: first.nextOffset });
  assert.equal(final.delivery.fullyRetrieved, true);
  assert.equal(final.delivery.acknowledged, false);
  const ack = await handleResult({ ...options, offset: final.nextOffset, acknowledge: true });
  assert.equal(ack.delivery.acknowledged, true);
  assert.ok(!(await handleStatus(options)).pendingReports.includes(job.id));
  assert.equal(readJobRecord({ jobsDir: paths.jobsDir, jobId: job.id }).status, 'completed');
});

test('lost workers recover completed journal output without another execution', async (t) => {
  const { cwd, paths, job } = saved(t, { status: 'running', pid: 12345 });
  const eventsFile = job.outputFile + '.jsonl';
  fs.writeFileSync(eventsFile, [init(job.sessionId), reply('Recovered reply'), done].map(line).join('\n') + '\n');
  fs.unlinkSync(job.outputFile);
  writeJobRecord({ jobsDir: paths.jobsDir, job: { ...job, eventsFile } });
  const result = await handleResult({ cwd, homeDir: cwd, jobId: job.id,
    deps: { killProcess() { throw Object.assign(new Error('missing'), { code: 'ESRCH' }); } } });
  assert.equal(result.status, 'completed');
  assert.equal(result.output, 'Recovered reply');
  assert.match(result.diagnostics, /recovered from saved events/);
});

test('damaged job metadata does not hide other reports or start a replacement', async (t) => {
  const { cwd, paths, job } = saved(t);
  fs.writeFileSync(path.join(paths.jobsDir, 'damaged.json'), '{');
  const status = await handleStatus({ cwd, homeDir: cwd });
  assert.equal(status.jobs.length, 2);
  assert.ok(status.jobs.find((item) => item.id === 'damaged').metadataError);
  assert.equal((await handleResult({ cwd, homeDir: cwd, jobId: job.id })).output, 'saved reply');
  assert.match((await handleResult({ cwd, homeDir: cwd, jobId: 'damaged' })).error, /saved job metadata/);
});

test('legacy session recovery requires a unique exact prompt, directory and time match', async (t) => {
  const { recoverLegacySessions } = await import('../plugins/claude-bridge/scripts/lib/session-recovery.mjs');
  const { cwd, paths, job } = saved(t, { sessionId: null, sessionReady: false,
    request: { prompt: 'exact saved prompt' }, startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:01:00.000Z' });
  const projectsDir = path.join(cwd, 'transcripts');
  const directory = path.join(projectsDir, cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(directory, { recursive: true });
  const sessionId = '11111111-1111-4111-8111-111111111111';
  const event = { type: 'user', cwd, sessionId, timestamp: '2026-01-01T00:00:01.000Z', message: { content: 'exact saved prompt' } };
  fs.writeFileSync(path.join(directory, sessionId + '.jsonl'), line(event) + '\n');
  const recovered = recoverLegacySessions({ jobsDir: paths.jobsDir, projectsDir });
  assert.deepEqual(recovered.recovered, [job.id]);
  assert.equal(readJobRecord({ jobsDir: paths.jobsDir, jobId: job.id }).sessionId, sessionId);
  writeJobRecord({ jobsDir: paths.jobsDir, job });
  const duplicateId = '22222222-2222-4222-8222-222222222222';
  fs.writeFileSync(path.join(directory, duplicateId + '.jsonl'), line({ ...event, sessionId: duplicateId }) + '\n');
  const ambiguous = recoverLegacySessions({ jobsDir: paths.jobsDir, projectsDir });
  assert.deepEqual(ambiguous.ambiguous, [job.id]);
  assert.equal(readJobRecord({ jobsDir: paths.jobsDir, jobId: job.id }).sessionId, null);
  fs.unlinkSync(path.join(directory, duplicateId + '.jsonl'));
  fs.writeFileSync(path.join(directory, sessionId + '.jsonl'), line({ ...event, timestamp: '2026-01-02T00:00:00Z' }) + '\n');
  assert.deepEqual(recoverLegacySessions({ jobsDir: paths.jobsDir, projectsDir }).recovered, []);
});

test('unexpected runner failures preserve output already written to disk', async (t) => {
  const { cwd } = fixture(t);
  const submitted = await handleDelegate({ cwd, homeDir: cwd, task: 'fixture', deps: {
    runClaudeForeground: async ({ outputFile }) => {
      fs.writeFileSync(outputFile, 'important saved partial output');
      throw new Error('unexpected projection failure');
    },
  } });
  const result = await handleResult({ cwd, homeDir: cwd, jobId: submitted.jobId });
  assert.equal(result.status, 'failed');
  assert.equal(result.output, 'important saved partial output');
  assert.match(result.diagnostics, /unexpected projection failure/);
});

test('duplicate workers do not execute or alter an already running job', async (t) => {
  const { runStoredJob } = await import('../plugins/claude-bridge/scripts/lib/execution.mjs');
  const { cwd, paths, job } = saved(t, { status: 'running', pid: 12345 });
  let runs = 0;
  const result = runStoredJob({ job, binary: 'unused', paths, run() { runs++; } });
  assert.equal(runs, 0);
  assert.equal(result.exitCode, 1);
  assert.equal(readJobRecord({ jobsDir: paths.jobsDir, jobId: job.id }).status, 'running');
  assert.equal(fs.readFileSync(job.outputFile, 'utf8'), 'saved reply');
});

test('a final result absent from intermediate messages is still saved', (t) => {
  const { paths } = fixture(t);
  const outputFile = path.join(paths.outputDir, 'reply.txt');
  const projector = createProjector({ outputFile });
  projector.consume(line(reply('Interim evidence')));
  projector.consume(line({ ...done, result: 'Final conclusion' }));
  assert.equal(fs.readFileSync(outputFile, 'utf8'), 'Interim evidence\n\nFinal conclusion');
});
