import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { customBinary, officialVariables } from '../../../plugins/codex-custom/agent/runtime.mjs';
import { installRuntime } from '../../../plugins/codex-custom/scripts/install.mjs';
import { configureDeepSeek } from '../../../plugins/codex-custom/scripts/deepseek.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'codex-custom-install-')), userHome = join(root, "user's home"), source = join(root, 'official');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(source, 'bin'), { recursive: true });
  writeFileSync(join(source, 'codex-package.json'), JSON.stringify({ version: '1.2.3', target: 'test-target', entrypoint: 'bin/codex' }));
  writeFileSync(join(source, 'resource'), 'native resources');
  const binary = '#!/bin/sh\nprintf "%s\\n" "$CODEX_HOME" "$CODEX_SQLITE_HOME" "$CODEX_PATH" "${CODEX_CONFIG-unset}" "${CODEX_MANAGED_PACKAGE_ROOT-unset}" "$@"\n';
  writeFileSync(join(source, 'bin/codex'), binary, { mode: 0o700 });
  return { root, userHome, source, version: '1.2.3', target: 'test-target' };
}

test('installation copies the native runtime and its resources; terminal invocations always use the custom home', t => {
  const f = fixture(t), installed = installRuntime(f);
  assert.equal(existsSync(join(f.source, 'bin/codex')), true);
  assert.notEqual(statSync(installed.binary).ino, statSync(join(f.source, 'bin/codex')).ino);
  assert.equal(readFileSync(join(installed.binary, '../../resource'), 'utf8'), 'native resources');
  const env = { HOME: f.userHome, PATH: '/bin', ...Object.fromEntries(officialVariables.map(key => [key, 'official-setting'])),
    CODEX_HOME: join(f.root, 'official-home'), CODEX_SQLITE_HOME: join(f.root, 'official-home'), CODEX_PATH: 'codex' };
  const ran = spawnSync(installed.launcher, ['argument with spaces', 'app-server'], { env, encoding: 'utf8' });
  assert.equal(ran.status, 0, ran.stderr);
  assert.deepEqual(ran.stdout.trim().split('\n'), [installed.customHome, installed.customHome, installed.launcher, 'unset', 'unset', 'argument with spaces', 'app-server']);
  assert.equal(existsSync(join(f.root, 'official-home')), false);
  const before = statSync(installed.binary).ino;
  assert.deepEqual(installRuntime(f), installed);
  assert.equal(statSync(installed.binary).ino, before, 'reinstalling the same version keeps the private native copy');
});

test('installation preserves an existing independently supplied custom executable', t => {
  const f = fixture(t), bin = join(f.userHome, '.local/bin');
  mkdirSync(bin, { recursive: true });
  const existing = join(bin, 'codex-custom');
  writeFileSync(existing, 'user-provided executable');
  assert.throws(() => installRuntime(f), /已存在且不是本插件安装/);
  assert.equal(readFileSync(existing, 'utf8'), 'user-provided executable');
  assert.equal(existsSync(join(f.userHome, '.codex-custom')), false);
});

test('the plugin finds the installed launcher without relying on the backend PATH, and skips unusable files', t => {
  const f = fixture(t), installed = installRuntime(f), pathDir = join(f.root, 'path');
  mkdirSync(pathDir);
  const alternate = join(pathDir, 'codex-custom');
  writeFileSync(alternate, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  assert.equal(customBinary({ PATH: pathDir }, f.userHome), installed.launcher);
  chmodSync(installed.launcher, 0o600);
  assert.equal(customBinary({ PATH: pathDir }, f.userHome), alternate);
  assert.equal(customBinary({ PATH: '' }, f.userHome), null);
});

test('DeepSeek setup saves the key only in a private config, lists its models, and never overwrites an existing config', t => {
  const f = fixture(t), key = 'test-private-deepseek-key';
  const configured = configureDeepSeek({ key, userHome: f.userHome });
  assert.equal(statSync(configured.config).mode & 0o777, 0o600);
  assert.equal(statSync(configured.catalog).mode & 0o777, 0o600);
  const config = readFileSync(configured.config, 'utf8'), catalog = readFileSync(configured.catalog, 'utf8');
  assert.ok(config.includes(`experimental_bearer_token = "${key}"`));
  assert.match(config, /base_url = "https:\/\/api.deepseek.com"/);
  assert.match(config, /requires_openai_auth = false/);
  assert.equal(catalog.includes(key), false);
  assert.deepEqual(JSON.parse(catalog).models.map(model => model.slug), ['deepseek-flash', 'deepseek-v4-pro']);
  assert.throws(() => configureDeepSeek({ key: 'replacement', userHome: f.userHome }), /已存在/);
  assert.equal(readFileSync(configured.config, 'utf8'), config);
});

test('missing or malformed DeepSeek credentials create no configuration', t => {
  const f = fixture(t);
  for (const key of ['', ' ', 'first\nsecond']) assert.throws(() => configureDeepSeek({ key, userHome: f.userHome }), /DEEPSEEK_API_KEY/);
  assert.equal(existsSync(join(f.userHome, '.codex-custom')), false);
});
