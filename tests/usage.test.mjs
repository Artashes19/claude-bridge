import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { normalizePlanUsage, readPlanUsage, cachedPlanUsage } from "../plugins/claude-bridge/scripts/lib/usage.mjs";
import { handleStatus, handleResult } from "../plugins/claude-bridge/scripts/lib/mcp-handlers.mjs";
import { createJobRecord, writeJobRecord } from "../plugins/claude-bridge/scripts/lib/jobs.mjs";

const payload = () => ({ subscription_type: "team", rate_limits_available: true, rate_limits: {
  limits: [
    { kind: "session", group: "session", percent: 9, resets_at: "2030-01-01T03:00:00Z", is_active: true },
    { kind: "weekly_all", group: "weekly", percent: 5, resets_at: "2030-01-03T12:00:00Z" },
    { kind: "weekly_scoped", group: "weekly", percent: 2, resets_at: "2030-01-03T12:00:00Z", scope: { model: { display_name: "Focused" } } },
  ], extra_usage: { is_enabled: false },
} });
function fixture(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-usage-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  return cwd;
}

test("account meters preserve all three limits, order, scope, and reset times", () => {
  const data = payload();
  data.email = "private";
  data.rate_limits.secret = "private";
  const result = normalizePlanUsage(data, "2030-01-01T00:00:00Z");
  assert.equal(result.scope, "account");
  assert.equal(result.modelPromptSent, false);
  assert.deepEqual(result.limits.map((row) => row.usedPercent), [9, 5, 2]);
  assert.deepEqual(result.limits.map((row) => row.remainingPercent), [91, 95, 98]);
  assert.deepEqual(result.limits.map((row) => row.label), ["Session limit", "Weekly · all models", "Weekly · Focused"]);
  assert.equal(result.limits[0].resetsInSeconds, 10800);
  assert.equal(result.limits[2].resetsAt, "2030-01-03T12:00:00Z");
  assert.equal(JSON.stringify(result).includes("private"), false);
});

test("new server meters remain visible and unknown percentages are not fabricated", () => {
  const data = payload();
  data.rate_limits.limits.push({ kind: "future_limit", group: "daily", label: "Daily allowance", percent: null, resets_at: "invalid" });
  const result = normalizePlanUsage(data);
  assert.equal(result.limits.length, 4);
  assert.equal(result.limits[3].label, "Daily allowance");
  assert.equal(result.limits[3].usedPercent, null);
  assert.equal(result.limits[3].remainingPercent, null);
  assert.equal(result.limits[3].resetsAt, null);
  data.rate_limits.limits = [];
  data.rate_limits.five_hour = { utilization: 90 };
  assert.deepEqual(normalizePlanUsage(data).limits, []);
});

test("older structured responses retain named model windows without duplication", () => {
  const result = normalizePlanUsage({ rate_limits_available: true, rate_limits: {
    five_hour: { utilization: 9 }, seven_day: { utilization: 5 },
    seven_day_example: { utilization: 20 }, model_scoped: [{ display_name: "Focused", utilization: 2 }],
  } });
  assert.deepEqual(result.limits.map((row) => row.usedPercent), [9, 5, 2]);
  assert.equal(result.limits[2].label, "Weekly · Focused");
  assert.equal(normalizePlanUsage({ rate_limits_available: false }).available, false);
});

test("usage requests share an in-flight check, bound cache age, and never submit input", async (t) => {
  const cwd = fixture(t);
  let queries = 0, closed = 0, released;
  const gate = new Promise((resolve) => { released = resolve; });
  const queryImpl = ({ prompt, options }) => {
    queries++;
    assert.equal(options.persistSession, false);
    assert.deepEqual(options.tools, []);
    assert.deepEqual(options.settingSources, []);
    return { close() { closed++; }, async usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(args) {
      assert.deepEqual(args, { skipBehaviors: true });
      await gate;
      void prompt[Symbol.asyncIterator]().next().then((item) => assert.equal(item.done, true));
      return payload();
    } };
  };
  const options = { binary: "fixture", cwd, homeDir: cwd, queryImpl };
  const first = readPlanUsage(options), second = readPlanUsage(options);
  released();
  assert.deepEqual(await first, await second);
  assert.equal(queries, 1);
  assert.equal(closed, 1);
  assert.equal((await readPlanUsage(options)).cached, true);
  const future = cachedPlanUsage(options, Date.now() + 61000);
  assert.equal(future.stale, true);
  await readPlanUsage({ ...options, refresh: true });
  assert.equal(queries, 2);
});

test("failed or unsupported checks return unavailable without a paid fallback", async (t) => {
  const cwd = fixture(t);
  for (const mode of ["unsupported", "reject", "timeout"]) {
    let closed = 0;
    const result = await readPlanUsage({ binary: mode, cwd, timeoutMs: 10,
      queryImpl: () => ({ close() { closed++; }, ...(mode === "unsupported" ? {} : {
        usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: () => mode === "reject" ? Promise.reject(new Error("private diagnostics")) : new Promise(() => {}),
      }) }),
    });
    assert.equal(result.available, false);
    assert.equal(result.modelPromptSent, false);
    assert.deepEqual(result.limits, []);
    assert.equal(JSON.stringify(result).includes("private diagnostics"), false);
    assert.equal(closed, 1);
  }
});

test("normal job responses show plan usage and hide dollar estimates unless requested", async (t) => {
  const cwd = fixture(t);
  fs.mkdirSync(path.join(cwd, ".git"));
  const jobsDir = path.join(cwd, ".claude-bridge", "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });
  const outputFile = path.join(cwd, "report");
  fs.writeFileSync(outputFile, "Saved report");
  const job = Object.assign(createJobRecord({ kind: "discuss", cwd, model: "example" }), {
    status: "completed", outputFile, sessionCostUsd: 0.196, modelUsage: { example: { inputTokens: 100, costUSD: 0.196 } },
  });
  writeJobRecord({ jobsDir, job });
  const options = { cwd, homeDir: cwd, jobId: job.id, deps: { checkGitRepository: () => ({ valid: true }) } };
  await readPlanUsage({ binary: "claude", cwd, homeDir: cwd, queryImpl: () => ({ close() {}, usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => payload() }) });
  const result = await handleResult(options);
  assert.deepEqual(result.planUsage.limits.map((row) => row.usedPercent), [9, 5, 2]);
  assert.equal(JSON.stringify(result).includes("0.196"), false);
  assert.equal(result.sessionCostUsd, undefined);
  assert.equal(result.modelUsage.example.inputTokens, 100);
  const status = await handleStatus(options);
  assert.equal(status.planUsage.available, true);
  assert.equal(JSON.stringify(status).includes("0.196"), false);
  const estimate = await handleResult({ ...options, includeCostEstimates: true });
  assert.equal(estimate.estimatedApiEquivalentUsd, 0.196);
  assert.equal(estimate.isBillingRecord, false);
  assert.match(estimate.costNote, /not a subscription charge/);
});

test("real transport usage tool sends control requests and zero user prompts", { timeout: 10000 }, async (t) => {
  const cwd = fixture(t);
  const binary = path.join(cwd, "runner.mjs");
  const log = path.join(cwd, "requests.jsonl");
  fs.writeFileSync(binary, `#!${process.execPath}
import fs from 'node:fs';
import readline from 'node:readline';
readline.createInterface({input:process.stdin}).on('line',(line)=>{
 const frame=JSON.parse(line);
 fs.appendFileSync(${JSON.stringify(log)},line+'\\n');
 const value=frame.request?.subtype==='get_usage'?${JSON.stringify(payload())}:{commands:[],models:[],account:{}};
 console.log(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:frame.request_id,response:value}}));
});
`, { mode: 0o755 });
  const client = new Client({ name: "usage-test", version: "1" });
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.resolve("plugins/claude-bridge/scripts/mcp-server.mjs")],
    cwd, env: { ...process.env, HOME: cwd, CLAUDE_BRIDGE_CLAUDE_BIN: binary }, stderr: "pipe" });
  try {
    await client.connect(transport);
    for (let i = 0; i < 2; i++) {
      const response = await client.callTool({ name: "bridge_usage", arguments: { cwd } });
      const result = JSON.parse(response.content[0].text);
      assert.deepEqual(result.limits.map((row) => row.usedPercent), [9, 5, 2]);
      assert.equal(result.cached, i === 1);
    }
    const frames = fs.readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
    assert.deepEqual(frames.map((frame) => frame.type), ["control_request", "control_request"]);
    assert.deepEqual(frames.map((frame) => frame.request.subtype), ["initialize", "get_usage"]);
    assert.equal(frames[1].request.skip_behaviors, true);
  } finally { await client.close(); }
});
