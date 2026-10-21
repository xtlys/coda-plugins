// Make a private native runtime copy and a terminal entry that always selects ~/.codex-custom.
// Run explicitly: node install.mjs --codex-plugin /path/to/plugins/codex
import { closeSync, constants, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { officialVariables } from '../agent/runtime.mjs';

const marker = '# coda-codex-custom isolated launcher';
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const managedLauncher = path => {
  const fd = openSync(path, 'r'), header = Buffer.alloc(100);
  try { return header.subarray(0, readSync(fd, header)).toString().includes(marker); }
  finally { closeSync(fd); }
};

export function nativeRuntime(plugin) {
  if (!plugin) throw new Error('请用 --codex-plugin 指定 codex 插件目录');
  const require = createRequire(join(resolve(plugin), 'package.json'));
  const platformPackage = `@openai/codex-${process.platform}-${process.arch}`;
  const targets = { 'darwin-arm64': 'aarch64-apple-darwin', 'darwin-x64': 'x86_64-apple-darwin',
    'linux-arm64': 'aarch64-unknown-linux-musl', 'linux-x64': 'x86_64-unknown-linux-musl' };
  const target = targets[`${process.platform}-${process.arch}`];
  if (!target) throw new Error('codex-custom 安装脚本目前支持 macOS 和 Linux');
  const version = JSON.parse(readFileSync(require.resolve('@openai/codex/package.json'), 'utf8')).version;
  const source = join(dirname(require.resolve(`${platformPackage}/package.json`)), 'vendor', target);
  return { source, version, target };
}

export function installRuntime({ source, version, target, userHome = homedir() }) {
  if (!/^[a-zA-Z0-9._-]+$/.test(version) || !/^[a-zA-Z0-9-]+$/.test(target)) throw new Error('无效的运行时版本或平台');
  const customHome = join(userHome, '.codex-custom'), bin = join(userHome, '.local/bin'), launcher = join(bin, 'codex-custom');
  if (existsSync(launcher) && !managedLauncher(launcher))
    throw new Error('~/.local/bin/codex-custom 已存在且不是本插件安装的入口，已保留');
  const layout = JSON.parse(readFileSync(join(source, 'codex-package.json'), 'utf8'));
  if (layout.entrypoint !== 'bin/codex' || !existsSync(join(source, layout.entrypoint))) throw new Error('Codex 运行时布局不匹配');
  mkdirSync(customHome, { recursive: true, mode: 0o700 });
  const runtimes = join(customHome, 'runtime'), name = `${version}-${target}`, runtime = join(runtimes, name);
  mkdirSync(runtimes, { recursive: true, mode: 0o700 });
  if (!existsSync(runtime)) {
    const staging = mkdtempSync(join(runtimes, '.install-'));
    try {
      cpSync(source, staging, { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE });
      renameSync(join(staging, 'bin/codex'), join(staging, 'bin/codex-custom'));
      writeFileSync(join(staging, 'codex-package.json'), JSON.stringify({ ...layout, entrypoint: 'bin/codex-custom' }, null, 2) + '\n');
      renameSync(staging, runtime);
    } finally { rmSync(staging, { recursive: true, force: true }); }
  }
  const copied = JSON.parse(readFileSync(join(runtime, 'codex-package.json'), 'utf8'));
  if (copied.entrypoint !== 'bin/codex-custom' || !existsSync(join(runtime, copied.entrypoint))) throw new Error('独立运行时不完整');
  mkdirSync(bin, { recursive: true });
  const program = `#!/bin/sh\n${marker}\numask 077\ncustom_home="\${HOME:?HOME is required}/.codex-custom"\n`
    + 'export CODEX_HOME="$custom_home" CODEX_SQLITE_HOME="$custom_home"\n'
    + 'export CODEX_PATH="$HOME/.local/bin/codex-custom"\n'
    + `unset ${officialVariables.join(' ')}\n`
    + `exec "$custom_home/runtime/"${quote(name)}"/bin/codex-custom" "$@"\n`;
  const pending = `${launcher}.${process.pid}`;
  try { writeFileSync(pending, program, { mode: 0o700, flag: 'wx' }); renameSync(pending, launcher); }
  finally { rmSync(pending, { force: true }); }
  return { launcher, binary: join(runtime, copied.entrypoint), customHome, version };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const index = process.argv.indexOf('--codex-plugin');
    const plugin = index >= 0 ? process.argv[index + 1] : JSON.parse(process.env.CODA_PLUGIN_DEPENDENCIES || '{}').codex;
    const installed = installRuntime(nativeRuntime(plugin));
    console.log(`Codex Custom ${installed.version}: ${installed.launcher}`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
