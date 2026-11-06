import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const plugin = fileURLToPath(new URL('..', import.meta.url));
export const base = '.github/vczh';
export const retiredBuiltinIds = ['workflow', 'vczh-project'];
export const hash = value => createHash('sha256').update(value).digest('hex');
export const now = () => new Date().toISOString();
export function requireValue(ok, message) { if (!ok) throw new Error(message); }
export function text(value, field, max = 20000) {
  requireValue(typeof value === 'string' && value.trim() && value.length <= max && !value.includes('\0'), `${field} 须为 1–${max} 字的文本`);
  return value;
}
export function id(value) { requireValue(typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,79}$/.test(value), 'ID 须为小写字母、数字或连字符，最长 80 字'); return value; }
export function strings(value, field, min = 1) {
  requireValue(Array.isArray(value) && value.length >= min && value.length <= 100, `${field} 须为 ${min}–100 项数组`);
  value.forEach(v => text(v, field)); return value;
}
export function json(file) { return JSON.parse(readFileSync(file, 'utf8')); }
export function git(root, ...args) { return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 15000, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
export function repo(cwd = process.cwd()) { return realpathSync(git(resolve(cwd), 'rev-parse', '--show-toplevel')); }

// Reject symlinks in managed paths, including dangling links. Never follow a repository's .github outside it.
export function inside(root, name) {
  requireValue(typeof name === 'string' && name && !isAbsolute(name) && !name.includes('\\') && !name.split('/').some(p => p === '..' || p === '.'), '需要仓库内的相对路径');
  const target = resolve(root, name);
  requireValue(target.startsWith(`${resolve(root)}${sep}`), '路径超出仓库');
  let part = resolve(root);
  for (const segment of relative(root, target).split(sep)) {
    part = join(part, segment);
    try { requireValue(!lstatSync(part).isSymbolicLink(), `不接受符号链接：${name}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return target;
}
export function atomic(file, content) {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { writeFileSync(temporary, content, { flag: 'wx', mode: 0o600 }); renameSync(temporary, file); }
  finally { rmSync(temporary, { force: true }); }
}
export const save = (file, value) => atomic(file, `${JSON.stringify(value, null, 2)}\n`);
export function managed(root, name) { return inside(root, `${base}/${name}`); }
// Git gives each linked worktree its own metadata directory. Runtime ownership must never
// travel with a commit, checkout or clone, even when a workflow commits every project change.
export function runtime(root, name) { return inside(realpathSync(git(root, 'rev-parse', '--absolute-git-dir')), `vczh/${name}`); }
export function prepareRuntime(root) {
  const file = managed(root, '.gitignore'), before = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const rules = ['/requests/', '/active-request.json', '/.*.lock'];
  const missing = rules.filter(rule => !before.split(/\r?\n/).includes(rule));
  if (missing.length) atomic(file, `${before}${before && !before.endsWith('\n') ? '\n' : ''}# vczh legacy runtime: local history only\n${missing.join('\n')}\n`);
  // Remove legacy snapshots from the index only; preserve their working files for reference.
  // Without -f, an index-only edit conflicting with the working copy fails instead of losing data.
  const tracked = git(root, 'ls-files', '-z', '--', `${base}/requests/`, `${base}/active-request.json`,
    `:(glob)${base}/.*.lock`, `:(glob)${base}/.*.lock/**`).split('\0').filter(Boolean);
  if (tracked.length) git(root, '--literal-pathspecs', 'rm', '-r', '--cached', '--sparse', '--', ...tracked);
  mkdirSync(runtime(root, 'requests'), { recursive: true });
}
export function config(root) {
  const value = json(managed(root, 'project.json'));
  requireValue(value.schemaVersion === 1 && typeof value.projectId === 'string', '不支持的项目数据版本');
  text(value.name, '项目名称');
  requireValue(Array.isArray(value.enabledPrompts), 'enabledPrompts 须为数组');
  value.enabledPrompts = value.enabledPrompts.filter(key => !retiredBuiltinIds.includes(key));
  return value;
}
export function lock(root, name, work) {
  const path = runtime(root, `.${id(name)}.lock`);
  mkdirSync(dirname(path), { recursive: true });
  try { mkdirSync(path); } catch (error) { if (error.code === 'EEXIST') throw new Error(`另一项操作持有 ${path}；确认进程已退出后才能删除残留锁`); throw error; }
  try { return work(); } finally { rmSync(path, { recursive: true, force: true }); }
}
export function register(root) {
  if (!process.env.CODA_PLUGIN_STATE) return;
  const cfg = config(root);
  save(join(process.env.CODA_PLUGIN_STATE, 'projects', `${hash(root)}.json`), { root, projectId: cfg.projectId, name: cfg.name, registeredAt: now() });
}
export function init(root) {
  const file = managed(root, 'project.json');
  mkdirSync(dirname(file), { recursive: true });
  if (!existsSync(file)) {
    const commonDir = realpathSync(resolve(root, git(root, 'rev-parse', '--git-common-dir')));
    const cfg = { schemaVersion: 1, projectId: hash(commonDir), name: root.split(sep).at(-1), enabledPrompts: ['general'] };
    try { writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`, { flag: 'wx' }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
  prepareRuntime(root);
  mkdirSync(managed(root, 'prompts'), { recursive: true });
  if (json(file).enabledPrompts.some(key => retiredBuiltinIds.includes(key))) save(file, config(root));
  const learning = '# !!!LEARNING!!!\n\n# Orders\n\n# Refinements\n';
  const defaults = {
    '.github/TaskLogs/Copilot_Investigate.md': '# !!!INVESTIGATE!!!\n',
    '.github/TaskLogs/Copilot_KB.md': '# !!!KNOWLEDGE BASE!!!\n',
    '.github/KnowledgeBase/Learning.md': learning,
    '.github/Learning/Learning_Coding.md': learning,
    '.github/Learning/Learning_Testing.md': learning,
    '.github/KnowledgeBase/Index.md': '# Knowledge Base\n\n## Guidance\n\n## Experiences and Learnings\n\n- [Learning](./Learning.md)\n\n# Copy of Online Manual\n',
    'Project.md': '# Project\n\n## Solution to Work On\n\n## Files not Allowed to Modify\n\n## Projects for Verification\n\n### Code Generation Tools\n\n### Code Generation Projects\n',
  };
  for (const [name, content] of Object.entries(defaults)) {
    const target = inside(root, name); mkdirSync(dirname(target), { recursive: true });
    if (!existsSync(target)) writeFileSync(target, content, { flag: 'wx' });
  }
  register(root); return config(root);
}
export function listFiles(root, folder, suffix) {
  const path = managed(root, folder);
  if (!existsSync(path)) return [];
  return readdirSync(path).filter(name => name.endsWith(suffix)).sort().map(name => managed(root, `${folder}/${name}`));
}
