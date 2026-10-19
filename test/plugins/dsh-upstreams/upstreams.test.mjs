import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { panelItems } from '../../../check/panel.mjs';
import { configure } from '../../../plugins/dsh-upstreams/scripts/configure.mjs';
import { baseUrlOf, choose, list, readStore, remove, save, selected } from '../../../plugins/dsh-upstreams/scripts/manager.mjs';
import { declaredPanel, manifest, pluginEnv, run } from '../command.mjs';

const declared = declaredPanel('dsh-upstreams');
const quote = text => `'${text.replaceAll("'", "'\\''")}'`;
async function setup(t) {
  const state = await mkdtemp(join(tmpdir(), 'coda-dsh-upstreams-'));
  t.after(() => rm(state, { recursive: true, force: true }));
  const env = extra => pluginEnv('dsh-upstreams', { CODA_NODE: process.execPath, CODA_PLUGIN_STATE: state, ...extra });
  const add = (name, extra = {}) => save({ name, baseUrl: 'https://example.com/anthropic', apiKey: `PRIVATE-${name}`, ...extra }, state);
  return { state, env, add };
}

test('private atomic storage preserves complete pairs, selection and same-name updates', async t => {
  const f = await setup(t);
  assert.deepEqual(list(f.state), { selected: null, upstreams: [] });
  await assert.rejects(async () => selected(f.state), /添加并选择/);
  const first = await f.add('first'), second = await f.add('second');
  assert.equal(selected(f.state).id, first.id);
  await choose(second.id, f.state);
  assert.equal(selected(f.state).apiKey, 'PRIVATE-second');
  const updated = await f.add('second', { baseUrl: 'https://new.example.com/anthropic/v1/', apiKey: 'NEW-PRIVATE' });
  assert.equal(updated.id, second.id);
  assert.equal(selected(f.state).baseUrl, 'https://new.example.com/anthropic/v1');
  assert.equal(selected(f.state).apiKey, 'NEW-PRIVATE');
  assert.ok(!JSON.stringify(list(f.state)).includes('PRIVATE'));
  assert.equal((await stat(f.state)).mode & 0o777, 0o700);
  assert.equal((await stat(join(f.state, 'upstreams.json'))).mode & 0o777, 0o600);
  await remove(second.id, f.state);
  assert.equal(list(f.state).selected, null);
  assert.throws(() => selected(f.state), /添加并选择/);
  await assert.rejects(choose('missing', f.state), /不存在/);
  assert.equal(list(f.state).upstreams.length, 1);
});

test('concurrent writers do not lose upstreams or mix a URL with another key', async t => {
  const f = await setup(t);
  await Promise.all(Array.from({ length: 8 }, (_, i) => f.add(`upstream-${i}`, { baseUrl: `https://example.com/${i}`, apiKey: `KEY-${i}` })));
  assert.equal(list(f.state).upstreams.length, 8);
  for (const upstream of readStore(f.state).upstreams) assert.equal(upstream.baseUrl.split('/').at(-1), upstream.apiKey.slice(4));
});

test('unsafe URLs, malformed keys and corrupt or symlinked stores fail without echoing secrets', async t => {
  const f = await setup(t);
  for (const baseUrl of ['file:///tmp/key', 'https://user:password@example.com', 'https://example.com?key=secret',
    'https://example.com#secret', 'https://example.com?', 'https://example.com\\other', 'https://example.com/messages', 'not a url'])
    assert.throws(() => baseUrlOf(baseUrl), /base_url/);
  for (const apiKey of ['', 'PRIVATE\nINJECTION', '密钥']) await assert.rejects(f.add('bad', { apiKey }), /API Key/);
  const secretFile = join(f.state, 'upstreams.json');
  await writeFile(secretFile, '{"PRIVATE":"not JSON');
  assert.throws(() => list(f.state), error => /无法读取/.test(error.message) && !error.message.includes('PRIVATE'));
  await assert.rejects(f.add('new'), /无法读取/);
  await rm(secretFile); await writeFile(join(f.state, 'elsewhere.json'), '{}');
  await symlink(join(f.state, 'elsewhere.json'), secretFile);
  assert.throws(() => list(f.state), /无法读取/);
});

test('Coda panel and actions expose only public upstream data', async t => {
  const f = await setup(t);
  const empty = await run(declared.command, f.env());
  assert.equal(empty.code, 0, empty.stderr); panelItems(empty.stdout, declared);
  assert.match(empty.stdout, /尚未配置/);
  const first = await f.add('first'), second = await f.add('second');
  const view = await run(declared.command, f.env());
  assert.equal(view.code, 0, view.stderr); panelItems(view.stdout, declared);
  assert.ok(!view.stdout.includes('PRIVATE'));
  const cards = JSON.parse(view.stdout).items.filter(i => i.type === 'card');
  assert.deepEqual(cards.map(c => c.title), ['first', 'second']);
  assert.equal(cards[0].items.find(i => i.action === 'select').disabled, true);
  const action = (name, upstream) => run(declared.actions[name].command, f.env({ CODA_PANEL_ARGS: JSON.stringify({ upstream }) }));
  assert.equal((await action('select', second.id)).code, 0);
  assert.equal(selected(f.state).id, second.id);
  assert.equal((await action('remove', second.id)).code, 0);
  assert.equal(list(f.state).selected, null);
  assert.equal((await action('select', first.id)).code, 0);
  assert.equal((await action('select', 'missing')).code, 1);
  assert.equal(selected(f.state).id, first.id);
});

test('the contributed command adds from a key file, lists safely and switches by name', async t => {
  const f = await setup(t), command = manifest('dsh-upstreams').contributes.commands[0].command;
  const keyFile = join(f.state, 'key.txt'); await writeFile(keyFile, 'CLI-PRIVATE\n', { mode: 0o600 });
  const added = await run(`${command} add --name 'with space' --base-url https://example.com/v1 --key-file ${quote(keyFile)}`, f.env());
  assert.equal(added.code, 0, added.stderr); assert.ok(!added.stdout.includes('CLI-PRIVATE'));
  assert.equal(selected(f.state).apiKey, 'CLI-PRIVATE');
  const publicList = await run(`${command} list`, f.env());
  assert.equal(publicList.code, 0); assert.ok(!publicList.stdout.includes('CLI-PRIVATE'));
  await f.add('other');
  assert.equal((await run(`${command} select other`, f.env())).code, 0);
  assert.equal(selected(f.state).name, 'other');
  assert.equal((await run(`${command} remove other`, f.env())).code, 0);
  assert.equal(list(f.state).selected, null);
});

test('the local form validates its origin and stores the submitted pair without reflecting the key', async t => {
  const f = await setup(t), controller = new AbortController();
  t.after(() => controller.abort());
  let ready;
  const urlReady = new Promise(resolve => { ready = resolve; });
  const done = configure({ state: f.state, signal: controller.signal, onReady: ready });
  const url = await urlReady, origin = new URL(url).origin;
  const page = await fetch(url);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.match(await page.text(), /type="password"/);
  const body = new URLSearchParams({ name: '<work>', baseUrl: 'https://example.com/anthropic', apiKey: 'FORM-PRIVATE' });
  assert.equal((await fetch(url, { method: 'POST', headers: { origin: 'https://evil.example' }, body })).status, 403);
  assert.equal(list(f.state).upstreams.length, 0);
  const saved = await fetch(url, { method: 'POST', headers: { origin }, body });
  const output = await saved.text();
  assert.equal(saved.status, 200); assert.ok(!output.includes('FORM-PRIVATE')); assert.match(output, /&lt;work&gt;/);
  assert.equal((await done).name, '<work>');
  assert.equal(selected(f.state).apiKey, 'FORM-PRIVATE');
});

test('cancelling configuration leaves no credentials and closes its server', async t => {
  const f = await setup(t), controller = new AbortController();
  let ready;
  const urlReady = new Promise(resolve => { ready = resolve; });
  const done = configure({ state: f.state, signal: controller.signal, onReady: ready });
  const rejected = assert.rejects(done, /已取消/), url = await urlReady;
  controller.abort(); await rejected;
  assert.equal(list(f.state).upstreams.length, 0);
  await assert.rejects(fetch(url));
});
