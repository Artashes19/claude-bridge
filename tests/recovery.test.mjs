import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

const script = path.resolve('plugins/claude-bridge/scripts/mcp-server.mjs');

async function connect(cwd, binary, environment = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [script],
    cwd,
    env: { ...process.env, HOME: cwd, CLAUDE_BRIDGE_CLAUDE_BIN: binary, ...environment },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'recovery-test', version: '1.0' });
  await client.connect(transport);
  return client;
}

async function call(client, name, args) {
  const response = await client.callTool({ name, arguments: args });
  return { ...JSON.parse(response.content[0].text), isError: response.isError };
}

test('long requests stay queryable and recover output after client disconnect', { timeout: 25000 }, async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-recovery-'));
  const binary = path.join(cwd, 'runner.mjs');
  fs.writeFileSync(binary, `#!${process.execPath}\nconst send = (text) => console.log(JSON.stringify({type:'assistant', message:{id:text, content:[{type:'text', text}]}}));\nsend('partial report\\n');\nsetTimeout(() => {send('final report\\n'); console.log(JSON.stringify({type:'result',subtype:'success',is_error:false}));}, 11500);\n`, { mode: 0o755 });
  assert.equal(spawnSync('git', ['init', '-q', cwd]).status, 0);
  let client;
  let submission;
  try {
    client = await connect(cwd, binary);
    const started = Date.now();
    const pending = call(client, 'bridge_delegate', { cwd, task: 'fixture task' });
    submission = pending;
    let status;
    do {
      await delay(25);
      status = await call(client, 'bridge_status', { cwd });
    } while (!status.jobs.length);
    assert.ok(Date.now() - started < 3000, 'status must respond while the task is running');
    const jobId = status.jobs[0].id;
    let partial;
    do {
      await delay(25);
      partial = await call(client, 'bridge_result', { cwd, jobId });
    } while (!partial.output && Date.now() - started < 3000);
    assert.equal(partial.status, 'running');
    assert.equal(partial.output, 'partial report\n');
    const submitted = await pending;
    assert.equal(submitted.jobId, jobId);
    assert.equal(submitted.background, true);
    assert.equal(submitted.status, 'running');
    assert.ok(Date.now() - started < 11250, 'long request must return before task completion');
    await client.close();
    client = await connect(cwd, binary);
    let completed;
    do {
      await delay(100);
      completed = await call(client, 'bridge_result', { cwd, jobId });
    } while (completed.status === 'running' && Date.now() - started < 18000);
    assert.equal(completed.status, 'completed');
    assert.equal(completed.output, 'partial report\n\n\nfinal report\n');
    assert.ok(fs.existsSync(completed.outputFile));
  } finally {
    await submission?.catch(() => {});
    await client?.close();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('failed task responses retain job identity and diagnostics', { timeout: 10000 }, async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-failure-'));
  const binary = path.join(cwd, 'runner.mjs');
  fs.writeFileSync(binary, `#!${process.execPath}\nconsole.log(JSON.stringify({type:'assistant',message:{id:'one',content:[{type:'text',text:'partial evidence\\n'}]}}));\nprocess.stderr.write('test failure\\n');\nprocess.exitCode = 7;\n`, { mode: 0o755 });
  assert.equal(spawnSync('git', ['init', '-q', cwd]).status, 0);
  let client;
  try {
    client = await connect(cwd, binary);
    const result = await call(client, 'bridge_delegate', { cwd, task: 'fixture task' });
    assert.equal(result.status, 'failed');
    assert.equal(result.isError, true);
    assert.ok(result.jobId);
    assert.equal(result.output, 'partial evidence\n');
    assert.match(result.diagnostics, /test failure/);
    const stored = await call(client, 'bridge_result', { cwd, jobId: result.jobId });
    assert.equal(stored.status, 'failed');
    assert.equal(stored.output, result.output);
  } finally {
    await client?.close();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('reconnected clients reuse one execution and retrieve every saved page', { timeout: 10000 }, async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-retry-'));
  const binary = path.join(cwd, 'runner.mjs');
  const countFile = path.join(cwd, 'launches.txt');
  const report = 'A🛰️Հայերեն\n'.repeat(1500);
  fs.writeFileSync(binary, `#!${process.execPath}\nimport fs from 'node:fs';\nfs.appendFileSync(${JSON.stringify(countFile)}, 'launch\\n');\nsetTimeout(() => {console.log(JSON.stringify({type:"result",subtype:"success",is_error:false,result:${JSON.stringify(report)}}));}, 1000);\n`, { mode: 0o755 });
  assert.equal(spawnSync('git', ['init', '-q', cwd]).status, 0);
  let client;
  let concurrentClient;
  try {
    client = await connect(cwd, binary);
    concurrentClient = await connect(cwd, binary);
    const options = { cwd, task: 'fixture task', requestId: 'stable-fixture-request', background: true };
    const [initial, concurrent] = await Promise.all([
      call(client, 'bridge_delegate', options), call(concurrentClient, 'bridge_delegate', options),
    ]);
    assert.equal(initial.jobId, concurrent.jobId);
    await concurrentClient.close();
    concurrentClient = null;
    await client.close();
    client = await connect(cwd, binary);
    const retry = await call(client, 'bridge_delegate', options);
    assert.equal(retry.jobId, initial.jobId);
    assert.equal(retry.reused, true);
    const firstPage = await call(client, 'bridge_result', { cwd, jobId: initial.jobId, waitSeconds: 5 });
    assert.equal(firstPage.status, 'completed');
    assert.equal(firstPage.hasMore, true);
    let restored = firstPage.output;
    let page = firstPage;
    while (page.hasMore) {
      page = await call(client, 'bridge_result', { cwd, jobId: initial.jobId, offset: page.nextOffset });
      restored += page.output;
    }
    assert.equal(restored, report);
    const completedRetry = await call(client, 'bridge_delegate', options);
    assert.equal(completedRetry.jobId, initial.jobId);
    assert.equal(completedRetry.reused, true);
    assert.equal(completedRetry.hasMore, true);
    assert.equal(fs.readFileSync(countFile, 'utf8'), 'launch\n');
    const runtime = await call(client, 'bridge_status', { cwd });
    assert.equal(runtime.runtime.version, '0.6.0');
  } finally {
    await concurrentClient?.close();
    await client?.close();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('discussion resumes after reconnect and concurrent turns cannot share a session', { timeout: 15000 }, async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-discussion-'));
  const binary = path.join(cwd, 'runner.mjs');
  const callsFile = path.join(cwd, 'calls.jsonl');
  fs.writeFileSync(binary, `#!${process.execPath}
import fs from 'node:fs';
const args=process.argv.slice(2);
const value=(flag)=>args.find((arg)=>arg.startsWith(flag+'='))?.slice(flag.length+1) ?? args[args.indexOf(flag)+1];
const resumed=args.some((arg)=>arg==='--resume'||arg.startsWith('--resume='));
const sessionId=value(resumed?'--resume':'--session-id');
if(!/^[a-f0-9-]{36}$/.test(sessionId))throw new Error('Missing fixture session identity: '+JSON.stringify(args));
if(!args.some((arg)=>arg.includes('AskUserQuestion')))throw new Error('Only clarification built-ins may be enabled: '+JSON.stringify(args));
fs.appendFileSync(${JSON.stringify(callsFile)},JSON.stringify({sessionId,resumed,prompt:args.at(-1)})+'\\n');
console.log(JSON.stringify({type:'system',subtype:'init',session_id:sessionId,model:'fixture-model'}));
setTimeout(()=>console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,session_id:sessionId,result:resumed?'Remembered earlier evidence':'Initial argument'})),700);
`, { mode: 0o755 });
  assert.equal(spawnSync('git', ['init', '-q', cwd]).status, 0);
  let client, secondClient;
  try {
    client = await connect(cwd, binary);
    const initial = await call(client, 'bridge_discuss', { cwd, message: 'Consider this evidence', model: 'test-model', effort: 'xhigh', background: true, requestId: 'discussion-start' });
    await client.close();
    client = await connect(cwd, binary);
    const firstReply = await call(client, 'bridge_result', { cwd, jobId: initial.jobId, waitSeconds: 5 });
    assert.equal(firstReply.status, 'completed', firstReply.diagnostics);
    secondClient = await connect(cwd, binary);
    const [left, right] = await Promise.all([
      call(client, 'bridge_discuss', { cwd, message: 'Challenge that argument', resume: initial.jobId, requestId: 'turn-left', background: true }),
      call(secondClient, 'bridge_discuss', { cwd, message: 'Reconsider that argument', resume: initial.jobId, requestId: 'turn-right', background: true }),
    ]);
    const turns = await Promise.all([left, right].map((turn) => turn.error && !turn.jobId ?
      { status: 'failed', diagnostics: turn.error } : call(client, 'bridge_result', { cwd, jobId: turn.jobId, waitSeconds: 5 })));
    assert.deepEqual(turns.map((turn) => turn.status).sort(), ['completed', 'failed']);
    const completed = turns.find((turn) => turn.status === 'completed');
    const failed = turns.find((turn) => turn.status === 'failed');
    assert.equal(completed.output, 'Remembered earlier evidence');
    assert.equal(completed.sessionId, firstReply.sessionId);
    assert.equal(completed.effort, 'xhigh');
    assert.equal(completed.settingsSource.effort, 'session');
    assert.match(failed.diagnostics, /already in use|inactive session/);
    const calls = fs.readFileSync(callsFile, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(calls.length, 2, 'only the initial turn and one follow-up may execute');
    assert.equal(calls[1].resumed, true);
    assert.ok(!calls[1].prompt.includes('Initial argument'));
  } finally {
    await secondClient?.close();
    await client?.close();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('clarification survives client reconnection and answer reuses the running worker', { timeout: 10000 }, async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-clarification-'));
  const binary = path.join(cwd, 'runner.mjs');
  const launches = path.join(cwd, 'launches.txt');
  fs.writeFileSync(binary, `#!${process.execPath}
import fs from 'node:fs';
import readline from 'node:readline';
fs.appendFileSync(${JSON.stringify(launches)}, 'launch\\n');
const send = (value) => console.log(JSON.stringify(value));
const sessionId=process.argv.find((arg)=>arg.startsWith('--session-id='))?.slice('--session-id='.length);
let started=false,steered=false;
readline.createInterface({input:process.stdin}).on('line',(line)=>{
 const message=JSON.parse(line);
 if(message.type==='control_request') {
  send({type:'control_response',response:{subtype:'success',request_id:message.request_id,response:{commands:[],models:[],account:{}}}});
 } else if(message.type==='user') {
  if(started){steered=true;return;}
  started=true;
  send({type:'system',subtype:'init',session_id:sessionId,model:'fixture'});
  send({type:'control_request',request_id:'question-control',request:{subtype:'can_use_tool',tool_name:'AskUserQuestion',tool_use_id:'question-tool',input:{questions:[{question:'Which baseline?',header:'Baseline',multiSelect:false,options:[{label:'Accepted',description:'Current evidence'},{label:'Alternative',description:'Explore'}]}]}}});
 } else if(message.type==='control_response'&&message.response.request_id==='question-control') {
  const answer=message.response.response.updatedInput.answers['Which baseline?'];
  send({type:'result',subtype:'success',is_error:false,session_id:sessionId,queued_turn_count:0,result:'Continued: '+answer+(steered?' | live input received':'')});
 }
});

`, { mode: 0o755 });
  assert.equal(spawnSync('git', ['init', '-q', cwd]).status, 0);
  let client;
  try {
    client = await connect(cwd, binary);
    const started = await call(client, 'bridge_discuss', { cwd, message: 'Ask for clarification', background: true, requestId: 'clarify-once' });
    const paused = await call(client, 'bridge_result', { cwd, jobId: started.jobId, waitSeconds: 5 });
    assert.equal(paused.status, 'needs_input', paused.diagnostics);
    const questionId = paused.interaction.questions[0].id;
    await client.close();
    client = await connect(cwd, binary);
    const reconnected = await call(client, 'bridge_result', { cwd, jobId: started.jobId, waitSeconds: 5 });
    assert.equal(reconnected.interaction.questions[0].id, questionId);
    const steering = { cwd, jobId: started.jobId, message: 'Additional evidence', requestId: 'one-live-input' };
    await call(client, 'bridge_steer', steering);
    for(let attempt=0;attempt<100;attempt++) {
      const current=await call(client,'bridge_result',{cwd,jobId:started.jobId});
      if(current.interaction.steering[0]?.state==='dispatched')break;
      await delay(10);
    }
    const response = await call(client, 'bridge_answer', { cwd, jobId: started.jobId, questionId, answers: { 'Which baseline?': 'Accepted, based on my evidence' } });
    assert.equal(response.submitted, true, response.error);
    let completed;
    for (let attempt=0;attempt<100;attempt++) {
      completed = await call(client, 'bridge_result', { cwd, jobId: started.jobId, waitSeconds: 1 });
      if(completed.status==='completed'||completed.status==='failed')break;
      await delay(20);
    }
    assert.equal(completed.status, 'completed', completed.diagnostics);
    assert.equal(completed.output, 'Continued: Accepted, based on my evidence | live input received');
    const retriedSteering = await call(client,'bridge_steer',steering);
    assert.equal(retriedSteering.reused,true,retriedSteering.error);
    assert.equal(retriedSteering.state,'dispatched');
    const retriedAnswer = await call(client,'bridge_answer',{cwd,jobId:started.jobId,questionId,answers:{'Which baseline?':'Accepted, based on my evidence'}});
    assert.equal(retriedAnswer.reused,true,retriedAnswer.error);
    assert.equal(fs.readFileSync(launches, 'utf8'), 'launch\n');
  } finally {
    await client?.close();
    fs.rmSync(cwd, { recursive:true, force:true });
  }
});


for (const fails of [false,true]) test(`worker automatically delivers its saved ${fails?'failure':'completion'} to the bound host`, {timeout:10000}, async () => {
  const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-delivery-'));
  const binary=path.join(cwd,'runner.mjs');
  const endpoint=path.join(cwd,'host.sock');
  const home=path.join(cwd,'home');fs.mkdirSync(home);
  const server=createServer();
  const sockets=new WebSocketServer({server});
  const received=[];
  sockets.on('connection',(socket)=>socket.on('message',(raw)=>{
    const message=JSON.parse(raw.toString());
    if(!message.id)return;
    let result={};
    if(message.method==='thread/turns/list')result={data:[{id:'host-turn',status:'inProgress'}]};
    if(message.method==='turn/steer'){
      received.push(message.params);
      result={turnId:'host-turn'};
    }
    socket.send(JSON.stringify({id:message.id,result}));
  }));
  await new Promise((resolve)=>server.listen(endpoint,resolve));
  fs.chmodSync(endpoint,0o600);
  fs.writeFileSync(binary,`#!${process.execPath}\nconsole.log(JSON.stringify({type:'assistant',message:{id:'evidence',content:[{type:'text',text:'Saved evidence from worker'}]}}));console.log(JSON.stringify({type:'result',subtype:${JSON.stringify(fails?'error_during_execution':'success')},is_error:${fails},queued_turn_count:0,errors:${JSON.stringify(fails?['Fixture failure']:[])},result:'Saved evidence from worker'}));\n`,{mode:0o755});
  assert.equal(spawnSync('git',['init','-q',cwd]).status,0);
  let client;
  try{
    client=await connect(cwd,binary,{HOME:home});
    const submission=await call(client,'bridge_discuss',{cwd,message:'Fixture evidence',background:true,requestId:'deliver-once',deliveryThreadId:'bound-host-thread',deliveryEndpoint:endpoint});
    const result=await call(client,'bridge_result',{cwd,jobId:submission.jobId,waitSeconds:5});
    assert.equal(result.status,fails?'failed':'completed',result.diagnostics);
    assert.equal(result.output,'Saved evidence from worker');
    for(let attempt=0;attempt<100&&!received.length;attempt++)await delay(10);
    assert.equal(received.length,1);
    assert.equal(received[0].threadId,'bound-host-thread');
    assert.equal(received[0].expectedTurnId,'host-turn');
    assert.match(received[0].input[0].text,new RegExp(`Status: ${fails?'failed':'completed'}`));
    assert.ok(received[0].input[0].text.includes(submission.jobId));
  }finally{
    await client?.close();
    for(const socket of sockets.clients)socket.terminate();
    await new Promise((resolve)=>sockets.close(resolve));
    await new Promise((resolve)=>server.close(resolve));
    fs.rmSync(cwd,{recursive:true,force:true});
  }
});
