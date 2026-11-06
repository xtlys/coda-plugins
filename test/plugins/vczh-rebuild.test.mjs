import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { hash } from '../../plugins/vczh/scripts/store.mjs';

test('rebuild removes retired source outputs and check detects files outside the generated set', t => {
  const root = mkdtempSync(join(tmpdir(), 'vczh-rebuild-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (path, text) => { const file = join(root, path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); };
  // A small pinned source set exercises the real generator without a network clone or repository mutation.
  write('scripts/vczh/spec.mjs', 'export const defaults = {}, overrides = [], rules = []; export const dimensions = { general: { title: "General", topics: {} }, cpp: { title: "C++", topics: {} } };');
  copyFileSync(new URL('../../scripts/vczh/rebuild.mjs', import.meta.url), join(root, 'scripts/vczh/rebuild.mjs'));
  const text = '# Prompt\n\nKeep the request.\n';
  const sources = { repository: 'https://example.com/upstream', commit: 'fixed', root: 'Copilot', files: ['keep', 'retired'].map(name => ({ path: `prompts/${name}.prompt.md`, sha256: hash(text) })) };
  for (const file of sources.files) write(`source/${file.path}`, text);
  const pin = () => write('scripts/vczh/sources.json', JSON.stringify(sources));
  const rebuild = (...args) => spawnSync(process.execPath, [join(root, 'scripts/vczh/rebuild.mjs'), '--source', join(root, 'source'), ...args], { encoding: 'utf8' });
  const passes = result => assert.equal(result.status, 0, result.stderr);
  const retired = join(root, 'plugins/vczh/upstream/prompts/retired.prompt.md');
  pin(); passes(rebuild()); passes(rebuild('--check')); assert.ok(existsSync(retired));
  sources.files.pop(); pin();
  assert.notEqual(rebuild('--check').status, 0);
  passes(rebuild());
  assert.equal(existsSync(retired), false);
  assert.equal(readFileSync(join(root, 'plugins/vczh/upstream/prompts/keep.prompt.md'), 'utf8'), text);
  passes(rebuild('--check'));
  write('plugins/vczh/upstream/unlisted/nested.prompt.md', text);
  const stale = rebuild('--check'); assert.notEqual(stale.status, 0); assert.match(stale.stderr, /Obsolete generated file/);
  passes(rebuild()); passes(rebuild('--check'));
  assert.equal(existsSync(join(root, 'plugins/vczh/upstream/unlisted/nested.prompt.md')), false);
  const link = join(root, 'plugins/vczh/upstream/unlisted/retired'); symlinkSync('missing', link);
  assert.match(rebuild('--check').stderr, /Obsolete generated file/);
  passes(rebuild()); assert.equal(lstatSync(link, { throwIfNoEntry: false }), undefined);
});
