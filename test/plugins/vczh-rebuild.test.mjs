import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { hash } from '../../plugins/vczh/scripts/store.mjs';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'vczh-rebuild-')), root = join(dir, 'repo');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const write = (path, text) => { const file = join(root, path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); };
  // A small pinned source set exercises the real generator without a network clone or repository mutation.
  write('scripts/vczh/spec.mjs', 'export const defaults = {}, overrides = [], rules = []; export const dimensions = { general: { title: "General", topics: {} }, cpp: { title: "C++", topics: {} } };');
  copyFileSync(new URL('../../scripts/vczh/rebuild.mjs', import.meta.url), join(root, 'scripts/vczh/rebuild.mjs'));
  const text = '# Prompt\n\nKeep the request.\n';
  const sources = { repository: 'https://example.com/upstream', commit: 'fixed', root: 'Copilot', files: ['keep', 'retired'].map(name => ({ path: `prompts/${name}.prompt.md`, sha256: hash(text) })) };
  for (const file of sources.files) write(`source/${file.path}`, text);
  const pin = () => write('scripts/vczh/sources.json', JSON.stringify(sources));
  const rebuild = (...args) => spawnSync(process.execPath, [join(root, 'scripts/vczh/rebuild.mjs'), '--source', join(root, 'source'), ...args], { encoding: 'utf8' });
  pin();
  return { dir, root, write, text, sources, pin, rebuild };
}
const passes = result => assert.equal(result.status, 0, result.stderr);
function snapshot(root) {
  return readdirSync(root).sort().map(name => {
    const path = join(root, name), stat = lstatSync(path);
    return [name, stat.isSymbolicLink() ? ['link', readlinkSync(path)] : stat.isDirectory() ? ['directory', snapshot(path)] : ['file', hash(readFileSync(path))]];
  });
}

test('rebuild removes retired source outputs and check detects files outside the generated set', t => {
  const { root, write, text, sources, pin, rebuild } = fixture(t);
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
  const prompts = join(root, 'plugins/vczh/upstream/prompts');
  rmSync(prompts, { recursive: true }); writeFileSync(prompts, 'stale file occupies a required directory');
  assert.notEqual(rebuild('--check').status, 0);
  assert.equal(readFileSync(prompts, 'utf8'), 'stale file occupies a required directory', '--check must not remove it');
  write('source/prompts/keep.prompt.md', 'changed source');
  const invalid = rebuild(); assert.notEqual(invalid.status, 0); assert.match(invalid.stderr, /Source changed/);
  assert.equal(readFileSync(prompts, 'utf8'), 'stale file occupies a required directory', 'validate sources before deleting anything');
  write('source/prompts/keep.prompt.md', text);
  passes(rebuild()); passes(rebuild('--check'));
  assert.ok(lstatSync(prompts).isDirectory());
  assert.equal(readFileSync(join(prompts, 'keep.prompt.md'), 'utf8'), text);
  for (const path of ['plugins/vczh/upstream', 'plugins/vczh/prompts', 'plugins/vczh', 'plugins', 'docs']) {
    const file = join(root, path);
    rmSync(file, { recursive: true }); writeFileSync(file, 'stale ancestor');
    assert.notEqual(rebuild('--check').status, 0, path);
    assert.equal(readFileSync(file, 'utf8'), 'stale ancestor', path);
    passes(rebuild()); passes(rebuild('--check'));
    assert.ok(lstatSync(file).isDirectory(), path);
  }
});

test('rebuild and check reject symlink outputs without changing external targets', t => {
  const { dir, root, rebuild } = fixture(t);
  passes(rebuild());
  for (const path of ['plugins/vczh/prompts/general.json', 'plugins/vczh/upstream/prompts/keep.prompt.md']) {
    const file = join(root, path), expected = readFileSync(file, 'utf8'), outside = join(dir, 'outside.txt');
    for (const body of [expected, 'unrelated external content']) {
      rmSync(file); writeFileSync(outside, body); symlinkSync(outside, file);
      const before = snapshot(dir);
      for (const args of [['--check'], []]) {
        const result = rebuild(...args);
        assert.notEqual(result.status, 0, `must reject ${path}`);
        assert.match(result.stderr, /Expected a regular generated file/);
        assert.ok(result.stderr.includes(path));
        assert.deepEqual(snapshot(dir), before, 'neither the generated tree nor the link target may change');
      }
      rmSync(file); writeFileSync(file, expected);
    }
  }
});

test('rebuild replaces files without overwriting hard-linked external data', t => {
  const { dir, root, rebuild } = fixture(t);
  passes(rebuild());
  const file = join(root, 'plugins/vczh/prompts/general.json'), expected = readFileSync(file, 'utf8'), outside = join(dir, 'outside.txt');
  rmSync(file); writeFileSync(outside, 'unrelated external content'); linkSync(outside, file);
  passes(rebuild()); passes(rebuild('--check'));
  assert.equal(readFileSync(outside, 'utf8'), 'unrelated external content');
  assert.equal(readFileSync(file, 'utf8'), expected);
});

test('rebuild rejects directories at output or retired file paths before any mutation', t => {
  const { root, write, rebuild } = fixture(t);
  passes(rebuild());
  for (const path of ['plugins/vczh/prompts/cpp.json', 'plugins/vczh/upstream/prompts/keep.prompt.md', 'plugins/vczh/prompts/workflow.json', 'plugins/vczh/prompts/vczh-project.json']) {
    const file = join(root, path);
    rmSync(file, { force: true }); write(`${path}/keep.txt`, 'directory content must survive');
    write('plugins/vczh/prompts/general.json', 'stale generated content');
    write('plugins/vczh/upstream/obsolete.txt', 'must not be removed before validation');
    const before = snapshot(root);
    for (const args of [[], ['--check']]) {
      const result = rebuild(...args);
      assert.notEqual(result.status, 0, path);
      assert.deepEqual(snapshot(root), before, 'all generated and obsolete files must remain unchanged');
      assert.match(result.stderr, /Expected a (?:regular generated file|removable obsolete file)/);
      assert.ok(result.stderr.includes(path));
    }
    rmSync(file, { recursive: true }); passes(rebuild());
  }
});
