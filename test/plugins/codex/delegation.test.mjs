// The real locked adapter, a fixture native app-server, and no model calls. The native-binary test separately observes
// the Responses request's tools/guidance, since a fixture accepting a feature flag cannot prove tool suppression.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { AgentProcess } from '../../../check/process.mjs';
import { cleared, clientCapabilities } from '../../../check/coda.mjs';
import { delegatedCodexTurns, codexDelegationConfig, codexDelegationPolicy } from '../../../plugins/codex/agent/delegation.mjs';
import { codexEffortOption } from '../../../plugins/codex/agent/options.mjs';
import { pluginDir, resolveFrom } from '../plugin.mjs';

const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const policy = (role = 'parent', instructions = 'Delegate independent work through Coda spawn and send.') => ({ version: 1, active: true,
  role, instructions, childInstructions: 'Complete your task yourself. Never delegate.', policies: [{ id: 'ultra', plugin: 'ultra', version: '1' }] });
const off = { version: 1, active: false };
const models = ['fake', 'other'].map(id => ({ id, model: id, displayName: id, description: '', hidden: false, isDefault: id === 'fake',
  defaultReasoningEffort: 'medium', inputModalities: ['text'], supportedReasoningEfforts: [
    { reasoningEffort: 'medium', description: '' }, { reasoningEffort: 'high', description: '' }],
  serviceTiers: [{ id: 'priority', name: 'Fast', description: '' }, { id: 'ultrafast', name: 'Ultrafast', description: '' }] }));

async function session(t, { delegation, env = {}, load = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'coda-codex-delegation-'));
  let proc;
  t.after(async () => { if (proc) { await proc.terminate(1000); proc.kill(); } rmSync(root, { recursive: true, force: true }); });
  const program = join(root, 'codex');
  writeFileSync(program, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fileURLToPath(new URL('./app-server-fixture.mjs', import.meta.url)))}\n`);
  chmodSync(program, 0o700); writeFileSync(join(root, 'died'), '');
  proc = new AgentProcess({ command: `exec ${quote(process.execPath)} ${quote(join(pluginDir('codex'), 'agent/entry.mjs'))}`, cwd: root,
    env: { ...cleared(process.env), CODEX_PATH: program, CODEX_HOME: join(root, 'home'), FAKE_CODEX_STATE: root,
      FAKE_CODEX_MODELS: JSON.stringify(models), ...env } });
  const request = async (method, params) => {
    const reply = await proc.request(method, params, { timeout: 10000 });
    assert.equal(reply.error, undefined, JSON.stringify(reply.error)); return reply.result;
  };
  const init = await request('initialize', { protocolVersion: 1, clientCapabilities: clientCapabilities() });
  const opened = await request(load ? 'session/load' : 'session/new', { cwd: root, mcpServers: [],
    ...(load ? { sessionId: 'fake-thread' } : {}), ...(delegation ? { _meta: { coda: { delegation } } } : {}) });
  const sessionId = opened.sessionId ?? 'fake-thread';
  const read = name => existsSync(join(root, name)) ? readFileSync(join(root, name), 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
  const configure = (delegation, execution = { agent: 'codex', model: 'fake', effort: 'medium', options: { 'service-tier': 'default' } }) => request('_coda/delegation/configure', { sessionId, delegation, execution });
  const prompt = delegation => request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'hello' }],
    ...(delegation === undefined ? {} : { _meta: { coda: { delegation } } }) });
  return { root, proc, init, opened, request, sessionId, read, configure, prompt };
}

test('a changed or already patched adapter fails before starting', () => {
  const source = readFileSync(resolveFrom('codex', '@agentclientprotocol/codex-acp'), 'utf8');
  const patched = delegatedCodexTurns(source);
  const syntax = spawnSync(process.execPath, ['--check', '--input-type=module'], { input: patched, encoding: 'utf8' });
  assert.equal(syntax.status, 0, syntax.stderr);
  assert.throws(() => delegatedCodexTurns(source.replace('    this.configPath = response?.codexHome ?? null;', '    this.configPath = null;')), /no longer matches/);
  assert.throws(() => delegatedCodexTurns(patched), /no longer matches/);
});

test('only known Codex effort labels have an explicit order; defaults never come from display order', () => {
  const option = values => ({ options: values.map(value => ({ value })) });
  assert.deepEqual(codexEffortOption(option(['high', 'medium']), { defaultReasoningEffort: 'medium' })._meta.coda,
    { effortOrder: ['medium', 'high'], defaultEffort: 'medium' });
  assert.deepEqual(codexEffortOption(option(['high', 'persistent', 'custom']), { defaultReasoningEffort: 'custom' })._meta.coda,
    { defaultEffort: 'custom' });
});

test('policy validation and feature overrides preserve the native baseline', () => {
  const base = { features: { multi_agent: true, multi_agent_v2: { enabled: false, wait_agent_enabled: true } }, 'features.multi_agent_v2.enabled': false };
  const before = structuredClone(base), active = codexDelegationConfig(base, policy());
  assert.deepEqual(base, before);
  assert.equal(active.features.multi_agent, false);
  assert.equal(active.features.multi_agent_v2, false);
  assert.equal(active.agents.enabled, false);
  assert.equal(active['features.multi_agent_v2.enabled'], undefined);
  assert.equal(codexDelegationConfig(base, off), base);
  for (const value of [null, { version: 2, active: false }, { version: 1, active: true }, { ...policy(), policies: [{}] }]) assert.throws(() => codexDelegationPolicy(value));
});

for (const load of [false, true]) test(`${load ? 'load' : 'new'} applies policy, confirms native settings, and revokes stale preparation`, async t => {
  const s = await session(t, { delegation: policy(), load });
  assert.deepEqual(s.init.agentCapabilities._meta.coda, { delegation: { version: 1, perTurn: true, disableNative: true, actualExecution: true }, waits: {} });
  const initial = s.read('threads.ndjson')[0];
  assert.equal(initial.params.config.features.multi_agent_v2, false);
  assert.equal(initial.params.config.agents.enabled, false);
  assert.equal(initial.params.developerInstructions, undefined, 'dynamic policy does not replace static session instructions');
  assert.deepEqual(await s.configure(policy()), { execution: { agent: 'codex', model: 'fake', effort: 'medium', options: { 'service-tier': 'default' } } });
  assert.equal(s.read('prompts.ndjson').length, 0, 'configuration delivers no task input');
  assert.equal((await s.prompt(policy())).stopReason, 'end_turn');
  assert.match(s.read('prompts.ndjson').filter(item => !item.outputSchema).at(-1).additionalContext['coda/delegation'].value, /Delegate independent work/);
  await s.request('session/set_config_option', { sessionId: s.sessionId, configId: 'service-tier', value: 'ultrafast' });
  let refused = await s.proc.request('session/prompt', { sessionId: s.sessionId, prompt: [{ type: 'text', text: 'must not start' }], _meta: { coda: { delegation: policy() } } });
  assert.match(refused.error?.message ?? '', /尚未通过原生确认/);
  await s.request('session/set_config_option', { sessionId: s.sessionId, configId: 'model', value: 'other' });
  await s.request('session/set_config_option', { sessionId: s.sessionId, configId: 'reasoning_effort', value: 'high' });
  await s.request('session/set_config_option', { sessionId: s.sessionId, configId: 'service-tier', value: 'ultrafast' });
  const desired = { agent: 'codex', model: 'other', effort: 'high', options: { 'service-tier': 'ultrafast' } };
  assert.deepEqual((await s.configure(policy(), desired)).execution, desired);
  const changed = policy('child', 'Finish this Coda child task yourself. Never delegate.');
  assert.deepEqual((await s.configure(changed, desired)).execution, desired);
  assert.equal(s.read('native.ndjson').some(item => item.method === 'thread/unsubscribe'), false, 'guidance changes do not reload an unchanged native tool set');
  await s.prompt(changed);
  assert.match(s.read('prompts.ndjson').filter(item => !item.outputSchema).at(-1).additionalContext['coda/delegation'].value, /Finish this Coda child/);
  assert.deepEqual((await s.configure(off, desired)).execution, desired);
  assert.equal(s.read('threads.ndjson').at(-2).params.config.features?.multi_agent_v2, undefined, 'native feature overrides are removed');
  await s.prompt(off);
  assert.match(s.read('prompts.ndjson').filter(item => !item.outputSchema).at(-1).additionalContext['coda/delegation'].value, /policy is now disabled/);
  refused = await s.proc.request('session/prompt', { sessionId: s.sessionId, prompt: [{ type: 'text', text: 'stale policy' }], _meta: { coda: { delegation: changed } } });
  assert.match(refused.error?.message ?? '', /尚未通过原生确认/);
});

test('host-shaped inactive metadata needs no preparation, including ordinary off/off model changes', async t => {
  const s = await session(t);
  assert.equal((await s.prompt({ ...off, role: 'parent', instructions: '', policies: [] })).stopReason, 'end_turn');
  await s.request('session/set_config_option', { sessionId: s.sessionId, configId: 'model', value: 'other' });
  assert.equal((await s.prompt(off)).stopReason, 'end_turn');
  assert.equal(s.read('prompts.ndjson').filter(item => !item.outputSchema).at(-1).model, 'other');
});

for (const field of ['model', 'effort', 'service-tier']) test(`an ignored native ${field} is rejected before any task input`, async t => {
  const s = await session(t, { delegation: policy(), env: { FAKE_CODEX_IGNORE_EXECUTION: field } });
  const desired = { agent: 'codex', model: 'other', effort: 'high', options: { 'service-tier': 'ultrafast' } };
  for (const [configId, value] of [['model', 'other'], ['reasoning_effort', 'high'], ['service-tier', 'ultrafast']])
    await s.request('session/set_config_option', { sessionId: s.sessionId, configId, value });
  const result = await s.proc.request('_coda/delegation/configure', { sessionId: s.sessionId, delegation: policy(), execution: desired });
  assert.match(result.error?.message ?? '', /实际执行配置不符/);
  const prompt = await s.proc.request('session/prompt', { sessionId: s.sessionId, prompt: [{ type: 'text', text: 'must not start' }], _meta: { coda: { delegation: policy() } } });
  assert.ok(prompt.error);
  assert.equal(s.read('prompts.ndjson').length, 0);
});

test('an unverified native runtime keeps ordinary behavior and does not advertise enforcement', async t => {
  const s = await session(t, { env: { FAKE_CODEX_USER_AGENT: 'codex_cli_rs/0.160.0' } });
  assert.equal(s.init.agentCapabilities._meta.coda.delegation, undefined);
  assert.equal((await s.prompt()).stopReason, 'end_turn');
  const unsupported = await s.proc.request('_coda/delegation/configure', { sessionId: s.sessionId, delegation: policy(), execution: { agent: 'codex', model: 'fake' } });
  assert.match(unsupported.error?.message ?? '', /只支持已验证/);
});
