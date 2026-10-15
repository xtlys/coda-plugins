import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CopilotRelay } from '../../../plugins/copilot/agent/relay.mjs';
import { AgentProcess, Exited } from '../../../check/process.mjs';
import { schemas } from '../../../check/schema.mjs';
import { pluginDir } from '../plugin.mjs';
import { manifest } from '../command.mjs';

const SESSION = 'copilot-session';
const update = (value, sessionId = SESSION) => ({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: value } });
const answer = (text, extra = {}) => update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text }, ...extra });
const start = (id = 'complete', summary = '文档已写好，改动尚未提交。') => update({
  sessionUpdate: 'tool_call', toolCallId: id, title: 'task_complete', status: 'in_progress', rawInput: { summary },
});
const completed = (fields = {}, id = 'complete') => update({ sessionUpdate: 'tool_call_update', toolCallId: id, status: 'completed', ...fields });
const prompt = (id = 1, sessionId = SESSION) => ({ jsonrpc: '2.0', id, method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text: '写好了吗' }] } });
const end = (id = 1, stopReason = 'end_turn') => ({ jsonrpc: '2.0', id, result: { stopReason } });
function setup() {
  const said = [], told = [];
  const relay = new CopilotRelay({ say: message => said.push(message), tell: message => told.push(message) });
  relay.fromCoda(prompt());
  return { relay, said, told, send: (...messages) => messages.forEach(message => relay.fromAgent(message)) };
}
const answers = said => said.filter(message => message.params?.update?.sessionUpdate === 'agent_message_chunk');

test('a task_complete summary becomes a standard answer before end_turn, in a separate message from progress', () => {
  const { send, said } = setup();
  const progress = answer('最后检查。');
  send(progress, start(), completed({ rawOutput: { summary: '文档已写好，改动尚未提交。' } }));
  assert.deepEqual(said, [progress], 'only the completion tool is held; progress is live');
  send(end());
  assert.equal(said.length, 3);
  const final = said[1];
  assert.equal(final.params.sessionId, SESSION);
  assert.equal(final.params.update.content.text, '文档已写好，改动尚未提交。');
  assert.match(final.params.update.messageId, /^copilot-completion-/);
  assert.equal(final.params.update.sessionUpdate, 'agent_message_chunk');
  assert.equal(schemas.zSessionNotification.safeParse(final.params).success, true);
  assert.deepEqual(said[2], end());
});

test('the issue sequence (rawInput.summary, text content and rawOutput.content) yields one final answer', () => {
  const { send, said } = setup();
  const summary = '这些修改上一轮已写进 `docs/ai-gateway-plan.md`，本次核对确认都在文中，未重复修改；改动尚未提交。';
  send(start('complete', summary), completed({
    content: [{ type: 'content', content: { type: 'text', text: summary } }], rawOutput: { content: summary },
  }), end());
  assert.equal(said.length, 2);
  assert.equal(answers(said)[0].params.update.content.text, summary);
});

test('only text in successful completion output is used, with output ahead of input', async t => {
  for (const [name, fields, expected] of [
    ['summary', { rawOutput: { summary: 'output', content: 'other' } }, 'output'],
    ['raw text', { rawOutput: { content: 'raw text' } }, 'raw text'],
    ['raw text blocks', { rawOutput: { content: [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }] } }, 'one\ntwo'],
    ['ACP content', { content: [{ type: 'content', content: { type: 'text', text: 'ACP content' } }] }, 'ACP content'],
    ['input fallback', {}, 'input'],
    ['empty output fallback', { rawOutput: { summary: ' \n ' }, content: [{ type: 'content', content: { type: 'image', data: 'ignored' } }] }, 'input'],
  ]) await t.test(name, () => {
    const { send, said } = setup();
    send(start('complete', 'input'), completed(fields), end());
    assert.equal(answers(said)[0].params.update.content.text, expected);
  });
});

test('equivalent native text, before or after completion, remains the only answer and has no trailing tool', async t => {
  for (const after of [false, true]) await t.test(after ? 'native reply after tool' : 'native reply before tool', () => {
    const { send, said } = setup();
    const native = [answer('文档已写好，'), answer('改动尚未提交。\r\n')];
    if (!after) send(...native);
    send(start(), completed());
    if (after) send(...native);
    send(end());
    assert.deepEqual(said, [...native, end()]);
  });
});

test('a distinct summary is retained; thought text and progress before a tool cannot suppress a final reply', async t => {
  for (const [name, prior] of [
    ['distinct answer', [answer('我会检查文件。')]],
    ['thought', [update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'done' } })]],
    ['earlier progress', [answer('done'), update({ sessionUpdate: 'tool_call', toolCallId: 'read', title: 'read_file', status: 'completed' })]],
  ]) await t.test(name, () => {
    const { send, said } = setup();
    send(...prior, start('complete', 'done'), completed(), end());
    assert.deepEqual(said.slice(0, prior.length), prior);
    assert.equal(said.at(-2).params.update.content.text, 'done');
  });
});

test('updates to an earlier tool do not break an already streamed equivalent reply', () => {
  const { send, said } = setup();
  const call = update({ sessionUpdate: 'tool_call', toolCallId: 'read', title: 'read_file', status: 'in_progress' });
  const done = update({ sessionUpdate: 'tool_call_update', toolCallId: 'read', status: 'completed' });
  const native = answer('done');
  send(call, native, done, start('complete', 'done'), completed(), end());
  assert.deepEqual(said, [call, native, done, end()]);
});

test('a separate native final message after progress is also deduplicated', () => {
  const { send, said } = setup();
  const progress = answer('checking', { messageId: 'progress' });
  const final = answer('done', { messageId: 'answer' });
  send(progress, final, start('complete', 'done'), completed(), end());
  assert.deepEqual(said, [progress, final, end()]);
});

test('failed, unfinished and empty completion tools are preserved instead of promoted', async t => {
  for (const [name, begin, done] of [
    ['failed', start(), completed({ status: 'failed', rawOutput: { summary: 'not a success' } })],
    ['unfinished', start(), completed({ status: 'in_progress' })],
    ['empty', start('complete', ' \n '), completed({ rawOutput: { summary: {} } })],
    ['no result', start(), null],
  ]) await t.test(name, () => {
    const { send, said } = setup();
    const calls = [begin, done].filter(Boolean);
    send(...calls, end());
    assert.deepEqual(said, [...calls, end()]);
  });
});

test('cancellation, other stop reasons, errors and process exit never invent a successful answer', async t => {
  for (const result of [end(1, 'cancelled'), end(1, 'max_tokens'), { jsonrpc: '2.0', id: 1, error: { code: -32603, message: 'ACP error' } }, null]) {
    await t.test(result?.result?.stopReason ?? (result ? 'error' : 'exit'), () => {
      const { send, said, relay } = setup();
      const calls = [start(), completed()];
      send(...calls);
      if (result) send(result); else relay.close();
      assert.deepEqual(said, [...calls, ...result ? [result] : []]);
    });
  }
});

test('all unrelated traffic, history replay, permissions and session instructions pass unchanged', () => {
  const { relay, send, said, told } = setup();
  const requests = [
    { jsonrpc: '2.0', id: 'init', method: 'initialize', params: { protocolVersion: 1 } },
    { jsonrpc: '2.0', id: 'new', method: 'session/new', params: { systemPrompt: { mode: 'append', content: [{ type: 'text', text: 'instructions' }] } } },
    { jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: SESSION } },
    { jsonrpc: '2.0', id: 'permission', result: { outcome: { outcome: 'cancelled' } } },
  ];
  requests.forEach(message => relay.fromCoda(message));
  const replies = [
    { jsonrpc: '2.0', id: 'init', result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } },
    { jsonrpc: '2.0', id: 'permission', method: 'session/request_permission', params: { sessionId: SESSION, options: [] } },
    update({ sessionUpdate: 'tool_call', title: 'task_complete', toolCallId: 'history', status: 'completed', rawOutput: { summary: 'old' } }, 'loading'),
    update({ sessionUpdate: 'tool_call', title: 'mcp__task_complete', toolCallId: 'other', status: 'completed' }),
    { jsonrpc: '2.0', id: 0, result: {} },
  ];
  send(...replies, end());
  assert.deepEqual(told, [prompt(), ...requests]);
  assert.deepEqual(said, [...replies, end()]);
});

test('summaries are scoped by session and prompt, including reused tool IDs and repeated completion updates', () => {
  const { send, said, relay } = setup();
  relay.fromCoda(prompt('other-prompt', 'other'));
  send(start('complete', 'first'), completed(), completed());
  send({ ...start('complete', 'other summary'), params: { ...start().params, sessionId: 'other', update: start('complete', 'other summary').params.update } });
  send({ ...completed(), params: { ...completed().params, sessionId: 'other' } });
  send(end('other-prompt'), end());
  assert.deepEqual(answers(said).map(message => [message.params.sessionId, message.params.update.content.text]), [['other', 'other summary'], [SESSION, 'first']]);
  relay.fromCoda(prompt(2));
  send(end(2));
  assert.equal(answers(said).length, 2, 'no old completion on the next turn');
  relay.fromCoda(prompt(3));
  send(start('complete', 'first'), completed(), end(3));
  assert.equal(answers(said).length, 3);
  assert.notEqual(answers(said)[1].params.update.messageId, answers(said)[2].params.update.messageId);
});

const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
async function entry(t) {
  const home = await mkdtemp(join(tmpdir(), 'coda copilot relay '));
  const bin = join(home, '.local/bin');
  await mkdir(bin, { recursive: true });
  const fixture = fileURLToPath(new URL('./fixtures/acp-agent.mjs', import.meta.url));
  await writeFile(join(bin, 'copilot'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fixture)} "$@"\n`, { mode: 0o755 });
  const said = [], noise = [];
  const agent = new AgentProcess({ command: manifest('copilot').contributes.agents[0].command, cwd: home,
    env: { ...process.env, HOME: home, PATH: bin, CODA_NODE: process.execPath, CODA_PLUGIN_PATH: pluginDir('copilot') },
    onMessage: message => said.push(message), onNoise: (...args) => noise.push(args) });
  t.after(async () => { await agent.terminate(1500); agent.kill(); await rm(home, { recursive: true, force: true }); });
  return { agent, said, noise };
}

test('the manifest entry adapts completion over stdio, preserves protocol errors, and exits when input closes', async t => {
  const { agent, said, noise } = await entry(t);
  const request = (scenario, onReply) => agent.request('session/prompt', { sessionId: SESSION, prompt: [{ type: 'text', text: scenario }] }, { timeout: 5000, onReply });
  await request('summary', reply => {
    assert.equal(reply.result.stopReason, 'end_turn');
    assert.equal(said.at(-1).params.update.content.text, '文档已写好，改动尚未提交。');
  });
  assert.equal(answers(said).length, 1);
  await request('duplicate');
  assert.equal(answers(said).length, 2);
  const error = await request('error');
  assert.deepEqual(error.error, { code: -32603, message: 'upstream error' });
  assert.equal(answers(said).length, 2);
  assert.equal(said.at(-1).params.update.sessionUpdate, 'tool_call_update');
  assert.deepEqual(noise, []);
  assert.notEqual(await agent.closeInput(5000), null);
  assert.equal((await agent.exited).code, 0);
});

test('the manifest entry flushes unconverted completion records and preserves a nonzero CLI exit', async t => {
  const { agent, said } = await entry(t);
  await assert.rejects(agent.request('session/prompt', { sessionId: SESSION, prompt: [{ type: 'text', text: 'exit' }] }, { timeout: 5000 }), Exited);
  assert.equal((await agent.exited).code, 7);
  assert.equal(answers(said).length, 0);
  assert.deepEqual(said.map(message => message.params.update.sessionUpdate), ['tool_call', 'tool_call_update']);
});
