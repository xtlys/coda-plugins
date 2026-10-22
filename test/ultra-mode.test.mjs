import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { checkPlugin } from '../check/index.mjs';

const source = fileURLToPath(new URL('../plugins/ultra/', import.meta.url));
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'ultra-plugin-check-')); cpSync(source, dir, { recursive: true });
  t.after(() => rmSync(dir, { recursive: true, force: true })); return dir;
}
test('Ultra is a loadable mode with an empty inheritance config and Coda delegation instructions', async t => {
  const dir = fixture(t), { report } = await checkPlugin(dir, { manifestOnly: true });
  assert.deepEqual(report.failures, []);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'subagents.json'))), {});
  assert.match(readFileSync(join(dir, 'instructions.md'), 'utf8'), /Coda MCP tools/);
  assert.ok(report.items.some(item => item.rule === 'manifest.sessionModes' && item.status === 'pass'));
});
test('the config accepts custom installed agent IDs and catches malformed settings', async t => {
  const dir = fixture(t);
  for (const agent of ['codex-custom', 'dsh']) {
    writeFileSync(join(dir, 'subagents.json'), JSON.stringify({ agent }));
    assert.deepEqual((await checkPlugin(dir, { manifestOnly: true })).report.failures, []);
  }
  for (const value of ['{broken', '{"mode":"danger-full-access"}', '{"options":{"fast":1}}']) {
    writeFileSync(join(dir, 'subagents.json'), value);
    assert.ok((await checkPlugin(dir, { manifestOnly: true })).report.failures.some(f => f.rule === 'manifest.sessionModes'));
  }
});
test('the checker refuses missing mode files and reserved command names', async t => {
  const dir = fixture(t), original = JSON.parse(readFileSync(join(dir, 'package.json')));
  for (const change of [{ instructions: '../outside.md' }, { instructions: 'missing.md' }, { id: 'subagent' }]) {
    const manifest = structuredClone(original); Object.assign(manifest.contributes.sessionModes[0], change);
    writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest));
    assert.ok((await checkPlugin(dir, { manifestOnly: true })).report.failures.some(f => f.rule === 'manifest.sessionModes'));
  }
});
