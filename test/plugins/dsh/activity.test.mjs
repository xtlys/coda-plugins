import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { harness, complete, text, until } from './harness.mjs';
import { DshWaits } from '../../../plugins/dsh/agent/waits.mjs';
import { questionForm, questionAnswer } from '../../../plugins/dsh/agent/questions.mjs';
import { turnError } from '../../../plugins/dsh/agent/errors.mjs';

test('waits retain causality while handling, renew continued children and validate stop ownership', async () => {
  const messages = [], waits = new DshWaits(p => messages.push(p), () => true);
  let stopped = 0;
  const first = waits.start('root', 'child', { kind: 'subagent', childSessionId: 'kid' }, () => stopped++);
  waits.handling('child'); waits.finish('child');
  assert.equal(messages.at(-1).state, 'handling');
  await assert.rejects(waits.stop('unrelated', first.waitId));
  await waits.stop('root', first.waitId);
  assert.equal(stopped, 1);
  waits.idle('root');
  assert.equal(messages.at(-1).state, 'done');
  const next = waits.start('root', 'child', { kind: 'subagent', childSessionId: 'kid' });
  assert.notEqual(next.waitId, first.waitId);
  const silent = new DshWaits(() => assert.fail('unnegotiated extension'), () => false);
  silent.start('root', 'job', { kind: 'task' }); silent.finish('job');
});

test('questions preserve arbitrary caller ids, multiple choices and free text', () => {
  const questions = [{ id: '__proto__', question: '选项', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }] }, { id: 'name', question: '姓名' }];
  assert.equal(questionForm(questions).properties.q0.items.anyOf[0].const, '0');
  assert.deepEqual(questionAnswer(questions, { action: 'accept', content: { q0: ['1', 'coda:other'], q0_other: 'C', q1: 'D' } }),
    { answers: [{ id: '__proto__', selected: ['B'], custom: 'C' }, { id: 'name', selected: [], custom: 'D' }] });
  assert.throws(() => questionAnswer(questions, { action: 'cancel' }), /取消/);
  assert.throws(() => questionAnswer(questions, { action: 'accept', content: { q0: ['9'] } }), /无效/);
});

test('only typed service faults are retryable, and nested auth or quota excludes retry', () => {
  class WireError extends Error { constructor(code, message, data) { super(message); this.code = code; this.data = data; } }
  for (const code of ['SERVER', 'RATE_LIMIT', 'STREAM_CLOSED', 'TIMEOUT']) {
    assert.equal(turnError({ code, message: 'test' }, WireError).data._meta.coda.failure.input, 'accepted');
  }
  for (const code of ['AUTH', 'QUOTA', 'MISSING_CREDENTIAL', 'INVALID_REQUEST', 'CONTEXT_WINDOW_EXCEEDED', 'BOGUS']) {
    assert.equal(turnError({ code, message: 'test' }, WireError).data, undefined);
  }
  assert.equal(turnError({ code: 'SERVER', cause: { code: 'AUTH', message: 'invalid key' } }, WireError).data, undefined);
});

test('cancel withdraws an unanswered form, settles the prompt, and the session remains usable', async t => {
  const h = await harness(t, (_body, res, count) => count === 1 ? complete(res, [{ type: 'tool_use', id: 'ask-cancel', name: 'ask_user_question',
    input: { questions: [{ id: 'q', question: '等待回答' }] } }], 'tool_use') : complete(res)), a = await h.start();
  const { sessionId } = (await a.newSession()).result;
  const pending = a.prompt(sessionId, 'ask');
  await until(() => a.messages.some(m => m.method === 'elicitation/create'));
  const question = a.messages.find(m => m.method === 'elicitation/create');
  a.agent.notify('session/cancel', { sessionId });
  assert.equal((await pending).result?.stopReason, 'cancelled');
  assert.ok(a.messages.some(m => m.method === '$/cancel_request' && m.params.id === question.id));
  a.agent.respond(question.id, { action: 'accept', content: { q0: 'LATE_ANSWER_SHOULD_BE_IGNORED' } });
  assert.equal((await a.prompt(sessionId, 'continue')).result?.stopReason, 'end_turn');
  assert.ok(!JSON.stringify(h.requests.at(-1)).includes('LATE_ANSWER_SHOULD_BE_IGNORED'));
});

test('native permissions are reported, switch durably, and invalid modes do not change them', async t => {
  const h = await harness(t), a = await h.start();
  const { sessionId } = (await a.newSession()).result;
  assert.ok((await a.request('session/set_mode', { sessionId, modeId: 'danger-full-access' })).result);
  assert.equal((await a.request('session/set_mode', { sessionId, modeId: 'not-a-mode' })).error.code, -32602);
  await a.prompt(sessionId, 'remember mode');
  await a.request('session/close', { sessionId });
  const restored = await a.request('session/load', { sessionId, cwd: h.dir, mcpServers: [] });
  assert.equal(restored.result.modes.currentModeId, 'danger-full-access');
});

test('native permission requests show the operation, accept one-shot decisions and withdraw on cancel', async t => {
  for (const cancel of [false, true]) await t.test(cancel ? 'cancel' : 'allow once', async t => {
    const h = await harness(t, (_body, res, count) => count === 1 ? complete(res, [{ type: 'tool_use', id: 'approval-1', name: 'bash',
      input: { description: 'Print test approval', command: 'printf APPROVED', sandbox_permissions: 'danger-full-access', justification: '测试一次性授权' } }], 'tool_use') : complete(res)), a = await h.start();
    const { sessionId } = (await a.newSession()).result;
    const pending = a.prompt(sessionId, 'approval');
    await until(() => a.messages.some(m => m.method === 'session/request_permission'));
    const permission = a.messages.find(m => m.method === 'session/request_permission');
    assert.equal(permission.params.toolCall.toolCallId, 'approval-1');
    assert.deepEqual(permission.params.options.map(o => o.kind), ['allow_once', 'reject_once']);
    if (cancel) {
      a.agent.notify('session/cancel', { sessionId });
      assert.equal((await pending).result?.stopReason, 'cancelled');
      assert.ok(a.messages.some(m => m.method === '$/cancel_request' && m.params.id === permission.id));
    } else {
      a.agent.respond(permission.id, { outcome: { outcome: 'selected', optionId: 'allow-once' } });
      assert.equal((await pending).result?.stopReason, 'end_turn');
      assert.ok(JSON.stringify(h.requests.at(-1)).includes('APPROVED'));
    }
  });
});

test('background jobs finish the foreground turn first, then report handling and terminal state', async t => {
  const h = await harness(t, (_body, res, count) => count === 1 ? complete(res, [{ type: 'tool_use', id: 'job-1', name: 'bash',
    input: { description: 'Wait for release then finish', command: 'while [ ! -f job-release ]; do sleep 0.05; done; printf done', run_in_background: true } }], 'tool_use') : complete(res)), a = await h.start();
  const { sessionId } = (await a.newSession()).result;
  await a.request('session/set_mode', { sessionId, modeId: 'danger-full-access' });
  assert.equal((await a.prompt(sessionId, 'background job')).result?.stopReason, 'end_turn');
  const wait = a.messages.find(m => m.method === '_coda/wait' && m.params.kind === 'task');
  assert.ok(wait, JSON.stringify(a.messages));
  assert.equal(wait.params.toolCallId, 'job-1');
  const states = () => a.messages.filter(m => m.method === '_coda/wait' && m.params.waitId === wait.params.waitId).map(m => m.params.state);
  assert.deepEqual(states(), ['waiting']);
  writeFileSync(join(h.dir, 'job-release'), '');
  await until(() => states().includes('done'));
  assert.deepEqual(states(), ['waiting', 'handling', 'done']);
});

test('background job stop addresses exactly the registered native job', async t => {
  const h = await harness(t, (_body, res, count) => count === 1 ? complete(res, [{ type: 'tool_use', id: 'job-stop', name: 'bash',
    input: { description: 'Wait until cancelled', command: 'sleep 30', run_in_background: true } }], 'tool_use') : complete(res)), a = await h.start();
  const { sessionId } = (await a.newSession()).result;
  await a.request('session/set_mode', { sessionId, modeId: 'danger-full-access' });
  await a.prompt(sessionId, 'background job');
  const wait = a.messages.find(m => m.method === '_coda/wait' && m.params.kind === 'task');
  assert.ok(wait, JSON.stringify(a.messages));
  assert.equal((await a.request('_coda/wait/stop', { sessionId: 'unrelated', waitId: wait.params.waitId })).error.code, -32602);
  const stopped = await a.request('_coda/wait/stop', { sessionId, waitId: wait.params.waitId });
  assert.ok(stopped.result, JSON.stringify(stopped));
  await until(() => a.messages.some(m => m.method === '_coda/wait' && m.params.waitId === wait.params.waitId && m.params.state === 'cancelled'));
});

test('a native child is visible while the root is idle, with its own output and a stoppable run', async t => {
  let childResponse;
  const h = await harness(t, (body, res, count) => {
    if (count === 1) return complete(res, [{ type: 'tool_use', id: 'child-1', name: 'subagent', input: { description: 'Mock child', prompt: 'CHILD_ONLY_TASK' } }], 'tool_use');
    const isChild = body.messages.some(m => m.role === 'user' && JSON.stringify(m.content).includes('CHILD_ONLY_TASK') && !JSON.stringify(m.content).includes('tool_result'));
    if (isChild) { childResponse = res; return; }
    complete(res);
  }), a = await h.start();
  const { sessionId } = (await a.newSession()).result;
  const result = await a.prompt(sessionId, 'start child');
  assert.equal(result.result?.stopReason, 'end_turn', JSON.stringify(result));
  await until(() => childResponse);
  assert.ok(h.requests.some(body => JSON.stringify(body.system).includes('Coda 测试 {{literal}}') && body.messages.some(m => m.role === 'user' && JSON.stringify(m.content).includes('CHILD_ONLY_TASK'))));
  const wait = a.messages.find(m => m.method === '_coda/wait' && m.params.kind === 'subagent');
  assert.ok(wait, JSON.stringify(a.messages));
  assert.equal(wait.params.stoppable, true);
  assert.equal(wait.params.title, 'Mock child');
  assert.ok(a.messages.some(m => m.method === '_coda/wait' && m.params.waitId === wait.params.waitId && m.params.model === 'deepseek-flash'));
  complete(childResponse, text('child result'));
  await until(() => a.messages.some(m => m.method === '_coda/wait' && m.params.waitId === wait.params.waitId && m.params.state === 'done'));
  assert.ok(a.messages.some(m => m.params?.sessionId === wait.params.childSessionId && m.params.update?.content?.text === 'child result'));
});

test('child replies keep the original activity and continuing a child creates a fresh stoppable run', async t => {
  let firstResponse, nextResponse, childStep = 0, rootStep = 0, continued = false, childId;
  const h = await harness(t, (body, res) => {
    const isChild = body.messages.some(m => m.role === 'user' && JSON.stringify(m.content).includes('CHILD_REPORT_TASK') && !JSON.stringify(m.content).includes('tool_result'));
    if (isChild) {
      childStep++;
      if (childStep === 1) { firstResponse = res; return; }
      if (childStep === 3) { nextResponse = res; return; }
      complete(res, text('child complete')); return;
    }
    rootStep++;
    if (rootStep === 1) return complete(res, [{ type: 'tool_use', id: 'spawn-report', name: 'subagent', input: { description: 'Report from child', prompt: 'CHILD_REPORT_TASK' } }], 'tool_use');
    if (!continued && body.messages.some(m => m.role === 'user' && JSON.stringify(m.content).includes('CONTINUE_CHILD_NOW'))) {
      continued = true;
      return complete(res, [{ type: 'tool_use', id: 'continue-report', name: 'send_message', input: { agent_id: childId, message: 'CHILD_CONTINUE_TASK' } }], 'tool_use');
    }
    complete(res, text('root complete'));
  }), a = await h.start();
  const { sessionId } = (await a.newSession()).result;
  await a.prompt(sessionId, 'start reporting child');
  await until(() => firstResponse);
  const first = a.messages.find(m => m.method === '_coda/wait' && m.params.kind === 'subagent').params;
  childId = first.childSessionId;
  complete(firstResponse, [{ type: 'tool_use', id: 'report-parent', name: 'send_message', input: { agent_id: sessionId, message: 'child reported result' } }], 'tool_use');
  await until(() => a.messages.some(m => m.method === '_coda/wait' && m.params.waitId === first.waitId && m.params.state === 'done'));
  assert.ok(a.messages.some(m => m.method === '_coda/wait' && m.params.waitId === first.waitId && m.params.state === 'handling'));
  await a.prompt(sessionId, 'CONTINUE_CHILD_NOW');
  await until(() => nextResponse);
  const runs = a.messages.filter(m => m.method === '_coda/wait' && m.params.kind === 'subagent').map(m => m.params);
  assert.equal(runs.length, 2, JSON.stringify({ waits: a.messages.filter(m => m.method === '_coda/wait'),
    requests: h.requests.map(b => b.messages.slice(-2)), stderr: a.agent.stderr }));
  assert.equal(runs[1].childSessionId, childId);
  assert.notEqual(runs[1].waitId, first.waitId);
  const stop = await a.request('_coda/wait/stop', { sessionId, waitId: runs[1].waitId });
  assert.ok(stop.result, JSON.stringify(stop));
  await until(() => a.messages.some(m => m.method === '_coda/wait' && m.params.waitId === runs[1].waitId && m.params.state === 'cancelled'));
});

test('nested children keep their owner and one activity across intermediate idle states', async t => {
  let grandchildResponse, childSteps = 0, rootSteps = 0;
  const h = await harness(t, (body, res) => {
    const task = marker => body.messages.some(m => m.role === 'user' && JSON.stringify(m.content).includes(marker) && !JSON.stringify(m.content).includes('tool_result'));
    if (task('GRANDCHILD_ONLY_TASK')) { grandchildResponse = res; return; }
    if (task('CHILD_PARENT_TASK')) {
      if (++childSteps === 1) return complete(res, [{ type: 'tool_use', id: 'spawn-grandchild', name: 'subagent',
        input: { description: 'Nested child', prompt: 'GRANDCHILD_ONLY_TASK' } }], 'tool_use');
      return complete(res, text('child is ready'));
    }
    if (++rootSteps === 1) return complete(res, [{ type: 'tool_use', id: 'spawn-parent', name: 'subagent',
      input: { description: 'Parent child', prompt: 'CHILD_PARENT_TASK' } }], 'tool_use');
    complete(res, text('root is ready'));
  });
  mkdirSync(h.env.DSH_HOME, { recursive: true });
  writeFileSync(join(h.env.DSH_HOME, 'cordis.patch.yml'), '- id: subagent\n  config:\n    maxDepth: 2\n');
  const a = await h.start();
  const { sessionId } = (await a.newSession()).result;
  assert.equal((await a.prompt(sessionId, 'nested work')).result?.stopReason, 'end_turn');
  await until(() => grandchildResponse && childSteps >= 2).catch(error => { throw new Error(JSON.stringify({ message: error.message,
    waits: a.messages.filter(m => m.method === '_coda/wait'), requests: h.requests.map(b => b.messages.slice(-3)), stderr: a.agent.stderr })); });
  const activities = () => a.messages.filter(m => m.method === '_coda/wait' && m.params.kind === 'subagent').map(m => m.params);
  const [child, grandchild] = activities();
  assert.equal(grandchild.sessionId, child.childSessionId);
  assert.ok(h.requests.some(body => JSON.stringify(body.system).includes('Coda 测试 {{literal}}') &&
    body.messages.some(m => m.role === 'user' && JSON.stringify(m.content).includes('GRANDCHILD_ONLY_TASK'))));
  complete(grandchildResponse, text('nested result'));
  await until(() => a.messages.some(m => m.method === '_coda/wait' && m.params.waitId === child.waitId && m.params.state === 'done'));
  assert.equal(activities().length, 2, JSON.stringify(a.messages.filter(m => m.method === '_coda/wait')));
  assert.ok(a.messages.some(m => m.method === '_coda/wait' && m.params.waitId === grandchild.waitId && m.params.state === 'done'));
});

test('session cancel ends autonomous handling and withdraws its pending question', async t => {
  const h = await harness(t, (_body, res, count) => {
    if (count === 1) return complete(res, [{ type: 'tool_use', id: 'autonomous-job', name: 'bash',
      input: { description: 'Wake for question', command: 'while [ ! -f question-release ]; do sleep 0.05; done; printf done', run_in_background: true } }], 'tool_use');
    if (count === 3) return complete(res, [{ type: 'tool_use', id: 'autonomous-question', name: 'ask_user_question',
      input: { questions: [{ id: 'q', question: '处理后台结果？' }] } }], 'tool_use');
    complete(res);
  }), a = await h.start();
  const { sessionId } = (await a.newSession()).result;
  await a.request('session/set_mode', { sessionId, modeId: 'danger-full-access' });
  assert.equal((await a.prompt(sessionId, 'start background work')).result?.stopReason, 'end_turn');
  writeFileSync(join(h.dir, 'question-release'), '');
  await until(() => a.messages.some(m => m.method === 'elicitation/create'));
  const question = a.messages.find(m => m.method === 'elicitation/create');
  const activity = a.messages.find(m => m.method === '_coda/wait' && m.params.kind === 'task').params;
  const states = () => a.messages.filter(m => m.method === '_coda/wait' && m.params.waitId === activity.waitId).map(m => m.params.state);
  assert.deepEqual(states(), ['waiting', 'handling']);
  a.agent.notify('session/cancel', { sessionId });
  await until(() => states().includes('done'));
  assert.ok(a.messages.some(m => m.method === '$/cancel_request' && m.params.id === question.id));
  assert.equal((await a.prompt(sessionId, 'continue after stopping')).result?.stopReason, 'end_turn');
});

test('ordinary ACP clients wait for children and receive no private or unknown-session notifications', async t => {
  let childResponse, settled = false;
  const h = await harness(t, (body, res, count) => {
    if (count === 1) return complete(res, [{ type: 'tool_use', id: 'plain-child', name: 'subagent',
      input: { description: 'Plain ACP child', prompt: 'PLAIN_CHILD_TASK' } }], 'tool_use');
    if (body.messages.some(m => m.role === 'user' && JSON.stringify(m.content).includes('PLAIN_CHILD_TASK') && !JSON.stringify(m.content).includes('tool_result'))) {
      childResponse = res; return;
    }
    complete(res);
  }), a = await h.start({}, {});
  const { sessionId } = (await a.newSession()).result;
  const pending = a.prompt(sessionId, 'plain ACP').then(result => { settled = true; return result; });
  await until(() => childResponse);
  assert.equal(settled, false);
  complete(childResponse, text('plain child result'));
  assert.equal((await pending).result?.stopReason, 'end_turn');
  assert.ok(!a.messages.some(m => m.method === '_coda/wait'));
  assert.ok(a.messages.filter(m => m.method === 'session/update').every(m => m.params.sessionId === sessionId));
});
