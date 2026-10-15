import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copilotBinary, readAccount } from '../../../plugins/copilot/scripts/account.mjs';
import { panelItems } from '../../../check/panel.mjs';
import { declaredPanel, run } from '../command.mjs';
import { pluginDir } from '../plugin.mjs';

const alive = pid => {
  try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; }
};

async function machine(t, mode = 'normal') {
  const home = await mkdtemp(join(tmpdir(), 'coda copilot account '));
  const tracePath = join(home, 'trace.jsonl');
  const binary = join(home, '.local/bin/copilot');
  await mkdir(join(home, '.local/bin'), { recursive: true });
  await writeFile(binary, `#!${process.execPath}\nimport ${JSON.stringify(new URL('./fixtures/account-server.mjs', import.meta.url).href)};\n`, { mode: 0o755 });
  // This isolated environment cannot send the host's GitHub credentials to a real CLI by mistake.
  const env = { HOME: home, PATH: '', FAKE_COPILOT_MODE: mode, FAKE_COPILOT_TRACE: tracePath };
  const trace = async () => (await readFile(tracePath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  t.after(async () => {
    try { for (const event of await trace()) if (event.event === 'start' && alive(event.pid)) process.kill(event.pid, 'SIGKILL'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await rm(home, { recursive: true, force: true });
  });
  return { home, binary, env, trace,
    read: options => readAccount({ env, timeoutMs: 2000, stopMs: 100, ...options }),
    async assertStopped() {
      const start = (await trace()).find(event => event.event === 'start');
      assert.ok(start, 'the fixture started');
      assert.equal(alive(start.pid), false, 'the query leaves no server process behind');
    },
  };
}

const requests = trace => trace.filter(event => event.event === 'request').map(event => event.message);

test('the isolated SDK query uses only connect, authentication and quota RPCs and decodes split UTF-8 frames', async t => {
  const m = await machine(t, 'fragmented');
  assert.deepEqual(await m.read(), {
    auth: { isAuthenticated: true, login: '张三🐙', authType: 'user' },
    quota: { quotaSnapshots: { premium_interactions: { remainingPercentage: 73.5 } } },
  });
  const trace = await m.trace();
  assert.deepEqual(trace[0].args, ['--headless', '--stdio', '--no-auto-update', '--log-level', 'none']);
  const sent = requests(trace);
  assert.deepEqual(sent.map(message => message.method), ['connect', 'auth.getStatus', 'account.getQuota']);
  assert.equal(new Set(sent.map(message => message.id)).size, sent.length, 'request IDs are unique');
  for (const event of trace.filter(event => event.event === 'request')) {
    assert.deepEqual(event.message.params, {});
    assert.equal(event.byteLength, Buffer.byteLength(JSON.stringify(event.message)), 'Content-Length measures bytes');
  }
  await m.assertStopped();
});

test('signed-out users do not trigger a quota request, and older servers fall back from connect to ping', async t => {
  const out = await machine(t, 'signed-out');
  assert.deepEqual(await out.read(), { auth: { isAuthenticated: false, login: '张三🐙', authType: 'user' } });
  assert.deepEqual(requests(await out.trace()).map(message => message.method), ['connect', 'auth.getStatus']);
  await out.assertStopped();
  const older = await machine(t, 'fallback');
  assert.equal((await older.read()).quota.quotaSnapshots.premium_interactions.remainingPercentage, 73.5);
  assert.deepEqual(requests(await older.trace()).map(message => message.method), ['connect', 'ping', 'auth.getStatus', 'account.getQuota']);
  await older.assertStopped();
});

test('RPC and malformed server failures are bounded user-facing errors, with no server diagnostic leakage', async t => {
  for (const [mode, expected] of [
    ['server-error', /额度查询失败.*-32001/], ['unsupported', /不支持额度查询.*升级/],
    ['missing-auth', /没有说明登录状态/], ['invalid-length', /无效的消息长度/], ['invalid-json', /无效的查询结果/],
  ]) {
    await t.test(mode, async t => {
      const m = await machine(t, mode);
      await assert.rejects(m.read(), error => {
        assert.match(error.message, expected);
        assert.doesNotMatch(error.message, /FAKE_SECRET_TOKEN|server diagnostic/);
        return true;
      });
      await m.assertStopped();
    });
  }
});

test('timeouts, early exit and ignored SIGTERM all finish promptly without a surviving server', async t => {
  for (const [mode, expected] of [['silent', /查询超时/], ['early-exit', /查询完成前退出/], ['ignore-sigterm', null]]) {
    await t.test(mode, async t => {
      const m = await machine(t, mode);
      const started = Date.now();
      const result = m.read({ timeoutMs: mode === 'silent' ? 1000 : 2000, stopMs: 80 });
      if (expected) await assert.rejects(result, expected);
      else assert.equal((await result).auth.isAuthenticated, true);
      assert.ok(Date.now() - started < 5000, 'completion and forced cleanup are bounded');
      if (mode === 'ignore-sigterm') assert.ok((await m.trace()).some(event => event.signal === 'SIGTERM'));
      await m.assertStopped();
    });
  }
});

test('binary lookup preserves paths with spaces and skips non-executable files and directories before PATH', async t => {
  const m = await machine(t);
  const pathDir = join(m.home, 'path with spaces');
  await mkdir(pathDir);
  const fallback = join(pathDir, 'copilot');
  await writeFile(fallback, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const env = { HOME: m.home, PATH: pathDir };
  assert.equal(copilotBinary(env), m.binary);
  await chmod(m.binary, 0o644);
  assert.equal(copilotBinary(env), fallback);
  await rm(m.binary);
  await mkdir(m.binary);
  assert.equal(copilotBinary(env), fallback);
  await chmod(fallback, 0o644);
  assert.equal(copilotBinary(env), null);
  await assert.rejects(readAccount({ env }), /找不到 Copilot CLI/);
  await assert.rejects(readAccount({ binary: join(m.home, 'missing'), env, stopMs: 80 }), /无法启动 Copilot CLI/);
});

test('the declared panel command returns one valid Coda reading for signed-in and signed-out accounts', async t => {
  const declared = declaredPanel('copilot');
  for (const mode of ['normal', 'signed-out']) {
    await t.test(mode, async t => {
      const m = await machine(t, mode);
      const result = await run(declared.command, { ...m.env, CODA_NODE: process.execPath, CODA_PLUGIN_PATH: pluginDir('copilot') });
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stderr, '');
      const output = JSON.parse(result.stdout);
      panelItems(result.stdout, { ...declared, actions: declared.actions ?? {} });
      if (mode === 'normal') assert.equal(output.items[0].items[0].fraction, 0.735);
      else assert.match(output.items[0].items[0].text, /copilot login/);
      assert.deepEqual(requests(await m.trace()).map(message => message.method),
        mode === 'normal' ? ['connect', 'auth.getStatus', 'account.getQuota'] : ['connect', 'auth.getStatus']);
      await m.assertStopped();
    });
  }
});
