import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { test } from 'node:test';
import { choose, remove, save } from '../../../plugins/dsh-upstreams/scripts/manager.mjs';
import { patchedUpstream, UpstreamSource } from '../../../plugins/dsh/agent/upstreams.mjs';
import { manifest } from '../command.mjs';
import { pluginDir, resolveFrom } from '../plugin.mjs';
import { complete, harness, instructions, until } from './harness.mjs';

function source(state) {
  return { CODA_PLUGIN_EXTENSIONS: JSON.stringify({ 'upstream-source': [{ plugin: 'dsh-upstreams',
    path: pluginDir('dsh-upstreams'), state, command: manifest('dsh-upstreams').contributes.extensions['dsh/upstream-source'].command }] }) };
}
const add = (state, name, baseUrl, apiKey) => save({ name, baseUrl, apiKey }, state);

test('the provider patch matches only the pinned native registration', async () => {
  const cli = resolveFrom('dsh', '@deepseek-ai/dsh/lib/bin.js');
  const source = await readFile(createRequire(cli).resolve('@deepseek-ai/dsh-llm-deepseek-api-key'), 'utf8');
  assert.match(patchedUpstream(source), /upstreamProvider\(\{/);
  assert.throws(() => patchedUpstream(source.replace('registerDeepSeekProvider(ctx, PROVIDER, {', 'changed')), /接入点已变化/);
});

test('real DSH uses the selected pair over native credentials and picks up switches, edits and process resumes', async t => {
  const received = [];
  const record = label => (_body, response, _count, request) => { received.push({ label, path: request.url, key: request.headers['x-api-key'] }); complete(response); };
  const a = await harness(t, record('a')), b = await harness(t, record('b'));
  const state = join(a.dir, 'upstreams');
  await add(state, 'a', `${a.env.DEEPSEEK_BASE_URL}/chosen-a`, 'PAIR-A');
  const second = await add(state, 'b', `${b.env.DEEPSEEK_BASE_URL}/chosen-b/v1`, 'PAIR-B');
  await mkdir(a.env.DSH_HOME, { recursive: true });
  const nativePath = join(a.env.DSH_HOME, '.credentials.yaml');
  const native = 'version: 1\nrefs:\n  DEEPSEEK_API_KEY: NATIVE-PRIVATE\n';
  await writeFile(nativePath, native);
  const agent = await a.start({ ...source(state), DEEPSEEK_API_KEY: 'ENV-PRIVATE' });
  assert.ok(agent.init.result, JSON.stringify(agent.init));
  const opened = await agent.newSession();
  assert.ok(opened.result, JSON.stringify(opened));
  const { sessionId } = opened.result;
  assert.equal((await agent.prompt(sessionId, 'first')).result?.stopReason, 'end_turn');
  await choose(second.id, state);
  assert.equal((await agent.prompt(sessionId, 'second')).result?.stopReason, 'end_turn');
  await add(state, 'b', `${b.env.DEEPSEEK_BASE_URL}/updated`, 'PAIR-B-NEW');
  assert.equal((await agent.prompt(sessionId, 'updated')).result?.stopReason, 'end_turn');
  assert.deepEqual(received, [
    { label: 'a', path: '/chosen-a/v1/messages', key: 'PAIR-A' },
    { label: 'b', path: '/chosen-b/v1/messages', key: 'PAIR-B' },
    { label: 'b', path: '/updated/v1/messages', key: 'PAIR-B-NEW' },
  ]);
  await agent.request('session/close', { sessionId }); await agent.agent.terminate(1500);
  const resumed = await a.start(source(state));
  assert.ok((await resumed.request('session/load', { sessionId, cwd: a.dir, mcpServers: [], systemPrompt: instructions('resume') })).result);
  assert.equal((await resumed.prompt(sessionId, 'continue')).result?.stopReason, 'end_turn');
  assert.deepEqual(received.at(-1), { label: 'b', path: '/updated/v1/messages', key: 'PAIR-B-NEW' });
  assert.equal(await readFile(nativePath, 'utf8'), native);
  assert.ok(!/PAIR-A|PAIR-B|NATIVE-PRIVATE|ENV-PRIVATE/.test(JSON.stringify([...agent.messages, ...resumed.messages])));
  const files = async dir => (await readdir(dir, { withFileTypes: true })).flatMap(entry => entry.isDirectory() ? [] : [join(dir, entry.name)])
    .concat(...await Promise.all((await readdir(dir, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => files(join(dir, entry.name)))));
  const logs = (await files(a.env.DSH_HOME)).filter(file => file !== nativePath);
  assert.ok(logs.length > 0);
  for (const file of logs) assert.ok(!/PAIR-A|PAIR-B|NATIVE-PRIVATE|ENV-PRIVATE/.test((await readFile(file)).toString()), file);
});

test('an in-flight request keeps its original URL and key after a switch', async t => {
  let release, firstKey;
  const a = await harness(t, async (_body, response, _count, request) => {
    firstKey = request.headers['x-api-key']; await new Promise(resolve => { release = resolve; }); complete(response);
  });
  const received = [];
  const b = await harness(t, (_body, response, _count, request) => { received.push(request.headers['x-api-key']); complete(response); });
  const state = join(a.dir, 'upstreams');
  await add(state, 'first', a.env.DEEPSEEK_BASE_URL, 'FIRST-PRIVATE');
  const second = await add(state, 'second', b.env.DEEPSEEK_BASE_URL, 'SECOND-PRIVATE');
  const agent = await a.start(source(state));
  const { sessionId } = (await agent.newSession()).result;
  const pending = agent.prompt(sessionId, 'hold first');
  await until(() => release);
  await choose(second.id, state);
  assert.equal(firstKey, 'FIRST-PRIVATE'); assert.deepEqual(received, []);
  release();
  assert.equal((await pending).result?.stopReason, 'end_turn');
  assert.equal((await agent.prompt(sessionId, 'next')).result?.stopReason, 'end_turn');
  assert.deepEqual(received, ['SECOND-PRIVATE']);
});

test('installed but unselected source fails closed, and adding or removing a selection is seen without restart', async t => {
  const h = await harness(t), state = join(h.dir, 'upstreams');
  const agent = await h.start(source(state));
  assert.ok(agent.init.result, JSON.stringify(agent.init));
  const empty = await agent.newSession();
  assert.equal(empty.error?.code, -32000, JSON.stringify(empty)); assert.match(empty.error.message, /添加并选择/);
  assert.equal(h.requests.length, 0);
  const upstream = await add(state, 'added', h.env.DEEPSEEK_BASE_URL, 'ADDED-PRIVATE');
  const created = await agent.newSession(); assert.ok(created.result, JSON.stringify(created));
  assert.equal((await agent.prompt(created.result.sessionId, 'works')).result?.stopReason, 'end_turn');
  await remove(upstream.id, state);
  const refused = await agent.prompt(created.result.sessionId, 'must not use native');
  assert.ok(refused.error, JSON.stringify(refused)); assert.match(refused.error.message, /添加并选择/);
  assert.equal(refused.error.data?._meta?.coda?.failure, undefined);
  assert.equal(h.requests.length, 1);
});

test('upstream IPC handles parallel requests and cancellation without waiting for its timeout', async t => {
  const h = await harness(t), state = join(h.dir, 'upstreams');
  await add(state, 'test', h.env.DEEPSEEK_BASE_URL, 'IPC-PRIVATE');
  const extension = JSON.parse(source(state).CODA_PLUGIN_EXTENSIONS)['upstream-source'][0];
  const bridge = new UpstreamSource(extension, { env: h.env });
  t.after(() => bridge.close());
  const pairs = await Promise.all(Array.from({ length: 5 }, () => bridge.selected()));
  assert.ok(pairs.every(p => p.apiKey === 'IPC-PRIVATE'));
  const stalled = new UpstreamSource({ ...extension, command: `exec "${process.execPath}" --input-type=module -e 'process.stdin.resume()'` });
  t.after(() => stalled.close());
  const controller = new AbortController();
  const request = assert.rejects(stalled.selected(controller.signal), /cancel upstream/);
  controller.abort(new Error('cancel upstream'));
  await request;
  assert.equal(stalled.pending.size, 0);
});
