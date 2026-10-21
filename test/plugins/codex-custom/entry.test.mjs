// Exercise the actual declared command and shared adapter with a PATH-only custom app-server.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { AgentProcess } from '../../../check/process.mjs';
import { clientCapabilities } from '../../../check/coda.mjs';
import { manifest, pluginEnv, run } from '../command.mjs';
import { pluginDir } from '../plugin.mjs';

const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const custom = manifest('codex-custom').contributes.agents[0];
const models = ['deepseek-fixture', 'grok-fixture'].map((id, index) => ({
  id, model: id, displayName: id, description: '', hidden: false, isDefault: index === 0,
  defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: '' }], inputModalities: ['text'],
}));

function fixture(t, { binary = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'coda-codex-custom-'));
  const userHome = join(root, "user's home"), officialHome = join(userHome, '.codex'), customHome = join(userHome, '.codex-custom');
  const bin = join(root, 'bin'), sourceUsed = join(root, 'official-used');
  mkdirSync(officialHome, { recursive: true }); mkdirSync(bin);
  writeFileSync(join(officialHome, 'config.toml'), 'model_provider = "openai"\n');
  writeFileSync(join(officialHome, 'auth.json'), '{"test":"official account must remain untouched"}\n');
  writeFileSync(join(bin, 'codex'), `#!/bin/sh\n: > ${quote(sourceUsed)}\nexit 99\n`, { mode: 0o700 });
  if (binary) writeFileSync(join(bin, 'codex-custom'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fileURLToPath(new URL('./app-server-fixture.mjs', import.meta.url)))} "$@"\n`, { mode: 0o700 });
  writeFileSync(join(root, 'died'), '');
  const env = { ...pluginEnv('codex-custom', {
    HOME: userHome, CODA_NODE: process.execPath, CODA_PLUGIN_STATE: root,
    CODA_PLUGIN_DEPENDENCIES: JSON.stringify({ codex: pluginDir('codex') }),
    CODA_PLUGIN_EXTENSIONS: JSON.stringify({ 'account-source': [{ command: `exec ${quote(join(bin, 'codex'))}`, path: root }] }),
    CODEX_PATH: join(bin, 'codex'), CODEX_HOME: officialHome, CODEX_SQLITE_HOME: officialHome,
    CODEX_CONFIG: '{"model_provider":"openai"}', MODEL_PROVIDER: 'openai', DEFAULT_AUTH_REQUEST: '{"type":"chatgpt"}',
    OPENAI_API_KEY: 'official-test-key', OPENAI_BASE_URL: 'https://official.invalid', CODEX_API_KEY: 'official-test-key', CODEX_ACCESS_TOKEN: 'official-test-token',
    CUSTOM_PROVIDER_TEST_KEY: 'custom-test-key', FAKE_CODEX_STATE: root, FAKE_CODEX_MODELS: JSON.stringify(models),
  }), PATH: bin };
  let proc;
  t.after(async () => { if (proc) { await proc.terminate(1000); proc.kill(); } rmSync(root, { recursive: true, force: true }); });
  return { root, env, customHome, officialHome, sourceUsed, start() {
    proc = new AgentProcess({ command: custom.command, cwd: root, env });
    return proc;
  } };
}

test('custom sessions use their named binary and private home, keep provider keys, and select the native custom models', async t => {
  const f = fixture(t), proc = f.start();
  const request = async (method, params) => {
    const reply = await proc.request(method, params, { timeout: 10_000 });
    assert.equal(reply.error, undefined, JSON.stringify(reply.error));
    return reply.result;
  };
  const initialized = await request('initialize', { protocolVersion: 1, clientCapabilities: clientCapabilities() });
  assert.deepEqual(initialized.agentCapabilities.sessionCapabilities.systemPrompt, {});
  const opened = await request('session/new', { cwd: f.root, mcpServers: [],
    systemPrompt: { mode: 'append', content: [{ type: 'text', text: 'Custom session instructions.' }] } });
  const model = opened.configOptions.find(option => option.category === 'model');
  assert.equal(model.currentValue, 'deepseek-fixture');
  assert.deepEqual(model.options.map(option => option.value), models.map(model => model.id));
  await request('session/set_config_option', { sessionId: opened.sessionId, configId: model.id, value: 'grok-fixture' });
  const prompted = await request('session/prompt', { sessionId: opened.sessionId, prompt: [{ type: 'text', text: 'hello custom' }] });
  assert.equal(prompted.stopReason, 'end_turn');
  const turns = readFileSync(join(f.root, 'prompts.ndjson'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(turns.find(turn => turn.input.some(item => item.text === 'hello custom')).model, 'grok-fixture');
  const threads = readFileSync(join(f.root, 'threads.ndjson'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(threads.find(thread => !thread.params.ephemeral).params.developerInstructions, 'Custom session instructions.');
  assert.deepEqual(JSON.parse(readFileSync(join(f.customHome, 'runtime.json'), 'utf8')), {
    args: ['app-server'], home: f.customHome, sqlite: f.customHome, binary: join(f.root, 'bin/codex-custom'), inherited: [], providerKey: 'custom-test-key',
  });
  assert.equal(statSync(f.customHome).mode & 0o777, 0o700);
  assert.equal(existsSync(f.sourceUsed), false, 'neither the official executable nor its account source was used');
  assert.deepEqual(readdirSync(f.officialHome).sort(), ['auth.json', 'config.toml']);
  assert.equal(readFileSync(join(f.officialHome, 'config.toml'), 'utf8'), 'model_provider = "openai"\n');
  assert.equal(readFileSync(join(f.officialHome, 'auth.json'), 'utf8'), '{"test":"official account must remain untouched"}\n');
});

test('a missing custom executable fails without falling back to the official executable', async t => {
  const f = fixture(t, { binary: false }), proc = f.start();
  assert.notEqual(await proc.exitWithin(10_000), null, proc.stderr);
  assert.notEqual(proc.exit.code, 0);
  assert.match(proc.stderr, /codex-custom.*ENOENT/);
  assert.equal(existsSync(f.sourceUsed), false);
  assert.equal(existsSync(join(f.customHome, 'runtime.json')), false);
});

test('the adapter must come from the declared installed dependency', async t => {
  const f = fixture(t);
  delete f.env.CODA_PLUGIN_DEPENDENCIES;
  const result = await run(custom.command, f.env);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /需要 codex 插件提供协议适配/);
  assert.equal(existsSync(f.customHome), false);
  assert.equal(existsSync(f.sourceUsed), false);
});
