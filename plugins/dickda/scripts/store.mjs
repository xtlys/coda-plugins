import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const plugin = fileURLToPath(new URL('..', import.meta.url));
export const base = '.dickda';
export const hash = value => createHash('sha256').update(value).digest('hex');
export function requireValue(ok, message) { if (!ok) throw new Error(message); }

export function text(value, field, max = 20000) {
  requireValue(typeof value === 'string' && value.trim() && value.length <= max && !value.includes('\0'), `${field} 须为 1–${max} 字的文本`);
  return value;
}

export function id(value) {
  requireValue(typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,79}$/.test(value), 'ID 须为小写字母、数字、下划线或连字符，最长 80 字');
  return value;
}

export function strings(value, field, min = 1) {
  requireValue(Array.isArray(value) && value.length >= min && value.length <= 100, `${field} 须为 ${min}–100 项数组`);
  value.forEach(v => text(v, field));
  return value;
}

export function json(file) { return JSON.parse(readFileSync(file, 'utf8')); }

export function git(root, ...args) {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8', timeout: 20000, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

export function remoteGit(root, ...args) {
  for (let attempt = 1; ; attempt++) {
    try {
      return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    } catch (error) {
      const transient = /\bEOF\b|SSL_ERROR_(?:SYSCALL|ZERO_RETURN)|SSL connect error|TLS connection was non-properly terminated|ECONNRESET|connection (?:was )?reset|timed?\s*out|HTTP(?:\/\S+)?\s+5\d\d\b|returned error: 5\d\d\b|curl (?:18|28|35|52|55|56|92)\b/i.test(error.stderr);
      if (!transient || attempt === 3) throw error;
      console.error(`git ${args[0]} 网络中断，第 ${attempt + 1} 次尝试`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250 * 2 ** (attempt - 1));
    }
  }
}

export function repo(cwd = process.cwd()) {
  return realpathSync(git(resolve(cwd), 'rev-parse', '--show-toplevel'));
}

// Reject symlinks anywhere along managed repository paths so asset reads/writes never escape the worktree.
export function inside(root, name) {
  requireValue(typeof name === 'string' && name && !isAbsolute(name) && !name.includes('\\') && !name.split('/').some(p => p === '..' || p === '.'), '需要仓库内的相对路径');
  const resolvedRoot = resolve(root);
  const target = resolve(resolvedRoot, name);
  requireValue(target.startsWith(`${resolvedRoot}${sep}`), '路径超出仓库');
  let part = resolvedRoot;
  for (const segment of relative(resolvedRoot, target).split(sep)) {
    part = join(part, segment);
    try { requireValue(!lstatSync(part).isSymbolicLink(), `不接受符号链接：${name}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return target;
}

export function atomic(file, content, mode = 0o644) {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, content, { flag: 'wx', mode });
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export const save = (file, value) => atomic(file, `${JSON.stringify(value, null, 2)}\n`, 0o600);
export function managed(root, name) { return inside(root, name ? `${base}/${name}` : base); }

// Per-worktree private runtime directory inside .git (or .git/worktrees/<name>): never committed or cloned.
export function runtime(root, name) {
  const gitDir = realpathSync(resolve(root, git(root, 'rev-parse', '--absolute-git-dir')));
  return inside(gitDir, `dickda/${name}`);
}

export function lock(root, name, work) {
  const path = runtime(root, `.${id(name)}.lock`);
  mkdirSync(dirname(path), { recursive: true });
  try { mkdirSync(path); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error(`另一项操作持有锁 ${path}；确认原进程已退出后才能移除残留锁`);
    throw error;
  }
  try { return work(); }
  finally { rmSync(path, { recursive: true, force: true }); }
}

export function config(root) {
  const value = json(managed(root, 'project.json'));
  requireValue(value.schemaVersion === 1 && typeof value.projectId === 'string', '不支持的 .dickda/project.json 版本');
  text(value.name, '项目名称');
  requireValue(Array.isArray(value.enabledPrompts), 'enabledPrompts 须为数组');
  if (value.verifyCommands !== undefined) strings(value.verifyCommands, 'verifyCommands', 0);
  return { verifyCommands: [], ...value };
}

export function projectGroup(root, remote) {
  if (!remote) {
    const remotes = git(root, 'remote').split('\n');
    const name = remotes.includes('origin') ? 'origin' : remotes[0];
    if (name) remote = git(root, 'config', '--get', `remote.${name}.url`);
  }
  if (remote) {
    const url = URL.parse(remote.includes('://') ? remote : remote.replace(/^([^/:]+):\/*/, 'ssh://$1/'));
    if (url?.protocol === 'ssh:' && url.port === '22') url.port = '';
    const repository = url && url.protocol !== 'file:'
      ? `${url.host}${url.pathname}`.toLowerCase().replace(/\/+$/, '').replace(/\.git$/, '')
      : resolve(root, url ? fileURLToPath(url) : remote);
    return `dickda:${hash(repository)}`;
  }
  const commonDir = realpathSync(resolve(root, git(root, 'rev-parse', '--git-common-dir')));
  return `dickda:${hash(commonDir)}`;
}

export const INVESTIGATE_MARKER = '# !!!DICKDA_INVESTIGATE!!!\n';
export const DEFAULT_PLAN = '# 五层技术方案\n\n## L1 · Codebase\n\n## L2 · Static Analysis\n\n## L3 · Verification\n\n## L4 · Work Graph & Prose\n\n## L5 · Human Review\n';

export function init(root) {
  const cfgFile = managed(root, 'project.json');
  mkdirSync(dirname(cfgFile), { recursive: true });
  if (!existsSync(cfgFile)) {
    const commonDir = realpathSync(resolve(root, git(root, 'rev-parse', '--git-common-dir')));
    const initial = {
      schemaVersion: 1,
      projectId: hash(commonDir),
      name: root.split(sep).at(-1),
      enabledPrompts: ['general'],
      verifyCommands: [],
    };
    try { writeFileSync(cfgFile, `${JSON.stringify(initial, null, 2)}\n`, { flag: 'wx' }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }

  for (const folder of ['tasks/logs', 'lints', 'verifiers', 'knowledge', 'learning', 'prompts']) {
    mkdirSync(managed(root, folder), { recursive: true });
  }
  mkdirSync(runtime(root, 'runs'), { recursive: true });

  const learningSeed = '# !!!LEARNING!!!\n\n## Orders\n\n## Refinements\n';
  const defaults = {
    '.gitignore': '# Local temporary scratch only; runtime state lives in git-dir/dickda/\n/*.tmp\n/*.tmp.html\n',
    'project.md': '# Project Facts\n\n## Build & Static Check Commands\n\n## Verification & UI Preview Commands\n\n## Protected / Do-Not-Modify Paths\n',
    'tasks/TODO_TASK.md': '# TODO TASK\n',
    'tasks/PLAN_5L.md': DEFAULT_PLAN,
    'tasks/logs/investigate.md': INVESTIGATE_MARKER,
    'knowledge/Index.md': '# Knowledge Base Index\n\n## Architecture & Modules\n\n## Domain & Decisions\n',
    'learning/Learning_General.md': learningSeed,
    'learning/Learning_Coding.md': learningSeed,
    'learning/Learning_Testing.md': learningSeed,
  };

  for (const [name, content] of Object.entries(defaults)) {
    const target = managed(root, name);
    mkdirSync(dirname(target), { recursive: true });
    if (!existsSync(target)) writeFileSync(target, content, { flag: 'wx' });
    else if (name === '.gitignore') {
      const rules = readFileSync(target, 'utf8');
      if (!/^\/?\*\.tmp\.html[ \t]*$/m.test(rules)) {
        const newline = rules.includes('\r\n') ? '\r\n' : '\n';
        appendFileSync(target, `${rules && !rules.endsWith('\n') ? newline : ''}/*.tmp.html${newline}`);
      }
    }
  }

  return config(root);
}

export function listFiles(root, folder, suffixes) {
  const dir = managed(root, folder);
  if (!existsSync(dir)) return [];
  const allowed = Array.isArray(suffixes) ? suffixes : [suffixes];
  const files = [];
  function visit(directory, prefix) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const name = `${prefix}/${entry.name}`;
      const path = managed(root, name);
      if (entry.isDirectory()) visit(path, name);
      else if (entry.isFile() && allowed.some(suffix => entry.name.endsWith(suffix))) files.push(path);
    }
  }
  visit(dir, folder);
  return files.sort();
}

export function appendGithubOutput(values, file = process.env.GITHUB_OUTPUT) {
  if (!file) return;
  for (const [key, raw] of Object.entries(values)) {
    const delimiter = randomUUID();
    const textValue = typeof raw === 'object' && raw !== null ? JSON.stringify(raw) : String(raw ?? '');
    atomicAppend(file, `${key}<<${delimiter}\n${textValue}\n${delimiter}\n`);
  }
}

function atomicAppend(file, chunk) {
  const prev = existsSync(file) ? readFileSync(file, 'utf8') : '';
  writeFileSync(file, `${prev}${chunk}`);
}
