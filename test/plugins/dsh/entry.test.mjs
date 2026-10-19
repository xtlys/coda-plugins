import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { checkPlugin } from '../../../check/index.mjs';
import { pluginDir, resolveFrom } from '../plugin.mjs';
import { patchedAcp } from '../../../plugins/dsh/agent/patch.mjs';
import { harness, complete, instructions, text, until } from './harness.mjs';

test('dsh patches only the pinned native adapter and passes manifest checks', async () => {
  const cli = resolveFrom('dsh', '@deepseek-ai/dsh/lib/bin.js');
  const source = readFileSync(createRequire(cli).resolve('@deepseek-ai/dsh-acp'), 'utf8');
  assert.ok(patchedAcp(source).includes('coda.install('));
  assert.throws(() => patchedAcp(source.replace('inflight.agentError = new Error(errorChain(error));', 'changed')), /接入点已变化/);
  const { report } = await checkPlugin(pluginDir('dsh'), { manifestOnly: true });
  assert.deepEqual(report.failures, []);
});

test('real harness reports Flash, literal system instructions, model settings and durable resume', async t => {
  const h = await harness(t), a = await h.start();
  assert.equal(a.init.result.agentCapabilities.loadSession, true);
  assert.deepEqual(a.init.result.agentCapabilities.sessionCapabilities.systemPrompt, {});
  assert.equal(a.init.result._meta.steering.supported, true);
  const invalid = await a.request('session/new', { cwd: h.dir, mcpServers: [], systemPrompt: { mode: 'override', content: text('bad') } });
  assert.equal(invalid.error.code, -32602);
  const created = await a.newSession();
  assert.ok(created.result, JSON.stringify(created));
  const { sessionId, configOptions } = created.result;
  assert.equal(configOptions.find(o => o.id === 'model').currentValue, '["deepseek-official","deepseek-flash"]');
  assert.deepEqual(configOptions.find(o => o.id === 'reasoning_effort').options.map(o => o.value), ['off', 'low', 'high', 'max']);
  assert.equal((await a.request('session/set_config_option', { sessionId, configId: 'reasoning_effort', value: 'low' })).result.configOptions[1].currentValue, 'low');
  assert.equal((await a.prompt(sessionId, 'first task')).result?.stopReason, 'end_turn');
  assert.equal(h.requests[0].model, 'deepseek-flash');
  assert.ok(JSON.stringify(h.requests[0]).includes('Coda 测试 {{literal}}'));
  assert.ok(a.messages.some(m => m.params?.update?.sessionUpdate === 'usage_update'));
  const idle = await a.request('_session/steering', { sessionId, prompt: text('idle input'), _meta: { steering: { idleBehavior: 'promptRequired' } } });
  assert.deepEqual(idle.result, { outcome: 'promptRequired', reason: 'noRunningTurn' });
  assert.equal(h.requests.length, 1);
  await a.request('session/close', { sessionId });
  await a.agent.terminate(1500);
  const b = await h.start();
  const restored = await b.request('session/load', { sessionId, cwd: h.dir, mcpServers: [], systemPrompt: instructions('updated Coda instructions') });
  assert.ok(restored.result, JSON.stringify(restored));
  assert.equal((await b.prompt(sessionId, 'second task')).result?.stopReason, 'end_turn');
  assert.ok(JSON.stringify(h.requests[1]).includes('first task'));
  assert.ok(JSON.stringify(h.requests[1]).includes('updated Coda instructions'));
  assert.ok(!JSON.stringify(h.requests[1]).includes('idle input'));
  assert.deepEqual([...a.noise, ...b.noise], []);
});

test('missing credentials use auth_required before creating a session', async t => {
  const h = await harness(t), a = await h.start({ DEEPSEEK_API_KEY: '' });
  assert.equal((await a.newSession()).error.code, -32000);
  assert.equal(h.requests.length, 0);
});

test('provider failures retain typed Coda retry facts without retrying in the plugin', async t => {
  const h = await harness(t, (_body, response) => {
    response.writeHead(503, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Mock overloaded' } }));
  }), a = await h.start();
  const { sessionId } = (await a.newSession()).result;
  const result = await a.prompt(sessionId, 'fail once');
  assert.equal(result.error?.code, -32603, JSON.stringify(result));
  assert.match(result.error.message, /Mock overloaded/);
  assert.deepEqual(result.error.data?._meta?.coda?.failure, { kind: 'service_unavailable', input: 'accepted' });
  assert.equal(h.requests.length, 1);
});

test('steering joins a running prompt and does not open a new ACP turn', async t => {
  let release;
  const h = await harness(t, async (_body, response, count) => {
    if (count === 1) await new Promise(resolve => { release = resolve; });
    complete(response);
  }), a = await h.start();
  const { sessionId } = (await a.newSession()).result;
  const pending = a.prompt(sessionId, 'running');
  await until(() => release);
  const steered = await a.request('_session/steering', { sessionId, prompt: text('steered task') });
  assert.equal(steered.result?.outcome, 'injected', JSON.stringify(steered));
  release();
  assert.equal((await pending).result?.stopReason, 'end_turn');
  assert.ok(h.requests.some(body => JSON.stringify(body).includes('steered task')));
});

test('native ask_user_question is a cancellable Coda form', async t => {
  const h = await harness(t, (_body, response, count) => count === 1 ? complete(response, [{ type: 'tool_use', id: 'ask-1', name: 'ask_user_question',
    input: { questions: [{ id: 'color', question: '选哪个？', options: [{ label: '红色' }, { label: '蓝色' }] }] } }], 'tool_use') : complete(response)), a = await h.start();
  const { sessionId } = (await a.newSession()).result;
  const pending = a.prompt(sessionId, 'ask');
  await until(() => a.messages.some(m => m.method === 'elicitation/create'));
  const question = a.messages.find(m => m.method === 'elicitation/create');
  assert.equal(question.params.requestedSchema.properties.q0.oneOf[0].title, '红色');
  a.agent.respond(question.id, { action: 'accept', content: { q0: '1' } });
  assert.equal((await pending).result?.stopReason, 'end_turn');
  assert.ok(h.requests.some(body => JSON.stringify(body).includes('蓝色')));
});

test('session instructions are scoped and native MCP calls round trip through ACP', async t => {
  const h = await harness(t, (_body, res, count) => count === 1 ? complete(res, [{ type: 'tool_use', id: 'mcp-1', name: 'mcp__fixture__echo', input: { text: 'roundtrip' } }], 'tool_use') : complete(res));
  const a = await h.start();
  const created = await a.request('session/new', { cwd: h.dir, systemPrompt: instructions('INSTRUCTIONS_ALPHA'), mcpServers: [{
    name: 'fixture', command: process.execPath, args: [fileURLToPath(new URL('./mcp-fixture.mjs', import.meta.url))], env: []
  }] });
  assert.ok(created.result, JSON.stringify(created));
  const other = await a.newSession('INSTRUCTIONS_BETA');
  assert.equal((await a.prompt(created.result.sessionId, 'call MCP')).result?.stopReason, 'end_turn');
  assert.ok(JSON.stringify(h.requests[1]).includes('MCP:roundtrip'));
  assert.ok(JSON.stringify(h.requests[1]).includes('INSTRUCTIONS_ALPHA'));
  assert.ok(!JSON.stringify(h.requests[1]).includes('INSTRUCTIONS_BETA'));
  await a.prompt(other.result.sessionId, 'independent');
  assert.ok(JSON.stringify(h.requests.at(-1)).includes('INSTRUCTIONS_BETA'));
  assert.ok(!JSON.stringify(h.requests.at(-1)).includes('INSTRUCTIONS_ALPHA'));
});

test('the real harness passes the full Coda contract with a local model endpoint', async t => {
  const h = await harness(t, (body, response) => {
    // Behave like the requested echo model: honor the system's exact-output instruction.
    const literal = JSON.stringify(body.system).match(/reply with exactly (coda-[0-9a-f]+) and nothing else/);
    complete(response, text(literal?.[1] ?? 'ok'));
  });
  const saved = Object.fromEntries(Object.keys(h.env).map(key => [key, process.env[key]]));
  Object.assign(process.env, h.env);
  try {
    const { report } = await checkPlugin(pluginDir('dsh'), { agent: 'dsh', live: true, limits: { settle: 1000, steerQuiet: 50 } });
    assert.deepEqual(report.failures, []);
    for (const rule of ['live.instructions', 'live.load', 'handshake.initialize', 'handshake.system-prompt', 'live.turn'])
      assert.ok(report.items.some(item => item.rule === rule && item.status === 'pass'), JSON.stringify(report.items));
  } finally {
    for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});
