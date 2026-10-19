import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { SessionInstructions } from '../../../plugins/copilot/agent/instructions.mjs';
import { AgentProcess } from '../../../check/process.mjs';
import { pluginDir } from '../plugin.mjs';
import { manifest } from '../command.mjs';

const systemPrompt = text => ({ mode: 'append', content: [{ type: 'text', text }] });
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;

test('the real entry bridges a CLI without systemPrompt: new, slash commands, later turns and resumed sessions', async t => {
  const home = await mkdtemp(join(tmpdir(), 'coda-copilot-instructions-'));
  const bin = join(home, '.local/bin');
  await mkdir(bin, { recursive: true });
  const fixture = fileURLToPath(new URL('../relay-fixture.mjs', import.meta.url));
  await writeFile(join(bin, 'copilot'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fixture)} "$@"\n`, { mode: 0o755 });
  const agents = [], messages = [];
  t.after(async () => {
    for (const agent of agents) { await agent.terminate(1500); agent.kill(); }
    await rm(home, { recursive: true, force: true });
  });
  const open = () => {
    const agent = new AgentProcess({ command: manifest('copilot').contributes.agents[0].command, cwd: home,
      env: { ...process.env, HOME: home, PATH: bin, CODA_NODE: process.execPath, CODA_PLUGIN_PATH: pluginDir('copilot') },
      onMessage: message => messages.push(message) });
    agents.push(agent); return agent;
  };
  const request = (agent, method, params) => agent.request(method, params, { timeout: 5000 });
  const initialize = agent => request(agent, 'initialize', { protocolVersion: 1, clientCapabilities: {} });
  const prompt = async (agent, text) => {
    assert.equal((await request(agent, 'session/prompt', { sessionId: 'native', prompt: [{ type: 'text', text }] })).result.stopReason, 'end_turn');
    return JSON.parse(messages.at(-1).params.update.content.text);
  };
  const p = open();
  assert.deepEqual((await initialize(p)).result.agentCapabilities.sessionCapabilities, { list: {}, systemPrompt: {} });
  for (const invalid of [{ mode: 'replace', content: [] }, { mode: 'append', content: [{ type: 'image' }] }, systemPrompt('a'.repeat(1024 * 1024 + 1))]) {
    assert.equal((await request(p, 'session/new', { cwd: home, mcpServers: [], systemPrompt: invalid })).error.code, -32602);
  }
  assert.equal((await request(p, 'session/new', { cwd: home, mcpServers: [], systemPrompt: systemPrompt('# Coda client') })).result.sessionId, 'native');
  assert.deepEqual((await prompt(p, '/help')).prompt, [{ type: 'text', text: '/help' }]);
  const first = await prompt(p, '你好');
  assert.deepEqual(first.argv, ['--acp', '--stdio']);
  assert.equal(first.leaked, false);
  assert.equal(first.prompt.length, 3);
  assert.match(first.prompt[0].text, /^<coda-session-instructions>\n[^]*# Coda client\n<\/coda-session-instructions>/);
  assert.match(first.prompt[1].text, /Put the complete, self-contained Markdown answer in summary/);
  assert.match(first.prompt[1].text, /Do not merely say you explained or completed something/);
  assert.deepEqual(first.prompt[2], { type: 'text', text: '你好' });
  const second = await prompt(p, '继续');
  assert.equal(second.prompt.length, 2);
  assert.deepEqual(second.prompt, [first.prompt[1], { type: 'text', text: '继续' }]);

  const q = open();
  await initialize(q);
  assert.ok((await request(q, 'session/load', { sessionId: 'native', cwd: home, mcpServers: [], systemPrompt: systemPrompt('# Coda client') })).result);
  const loaded = await prompt(q, '继续');
  assert.equal(loaded.leaked, false);
  assert.deepEqual(loaded.prompt, second.prompt, 'resumed sessions get the reply contract without repeating all session instructions');
});

test('instruction-derived titles are removed; normal titles and other metadata are retained', () => {
  const bridge = new SessionInstructions();
  const message = title => ({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's',
    update: { sessionUpdate: 'session_info_update', title, updatedAt: '2026-10-20T00:00:00Z' } } });
  for (const prefix of ['<coda-session-instructions>', '<coda-reply-instructions>']) {
    const next = bridge.fromAgent(message(prefix + ' ...'));
    assert.equal(next.params.update.title, undefined);
    assert.equal(next.params.update.updatedAt, '2026-10-20T00:00:00Z');
  }
  assert.deepEqual(bridge.fromAgent(message('解释 BYOK')), message('解释 BYOK'));
});

test('failed session creation cannot leak its instructions into another session', () => {
  const bridge = new SessionInstructions();
  bridge.fromCoda({ jsonrpc: '2.0', id: 1, method: 'session/new', params: { systemPrompt: systemPrompt('private session A') } });
  bridge.fromAgent({ jsonrpc: '2.0', id: 1, error: { code: -32603, message: 'failed' } });
  const result = bridge.fromCoda({ jsonrpc: '2.0', id: 2, method: 'session/prompt', params: {
    sessionId: 'B', prompt: [{ type: 'text', text: '你好' }, { type: 'image', mimeType: 'image/png', data: 'image' }],
  } }).agent;
  assert.equal(JSON.stringify(result).includes('private session A'), false);
  assert.deepEqual(result.params.prompt.slice(1), [{ type: 'text', text: '你好' }, { type: 'image', mimeType: 'image/png', data: 'image' }]);
});
