import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const plugin = fileURLToPath(new URL('..', import.meta.url));
export const base = '.github/vczh';
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
export function config(root) {
  const value = json(managed(root, 'project.json'));
  requireValue(value.schemaVersion === 1 && typeof value.projectId === 'string', '不支持的项目数据版本');
  requireValue(Number.isInteger(value.maxReviewRounds) && value.maxReviewRounds >= 1 && value.maxReviewRounds <= 20, 'maxReviewRounds 必须为 1–20');
  return value;
}
export function lock(root, name, work) {
  const path = managed(root, `.${id(name)}.lock`);
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
    const cfg = { schemaVersion: 1, projectId: hash(commonDir), name: root.split(sep).at(-1), maxReviewRounds: 3, enabledPrompts: ['general'] };
    try { writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`, { flag: 'wx' }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
  for (const dir of ['KnowledgeBase', 'Learning', 'TaskLogs', 'prompts']) mkdirSync(managed(root, dir), { recursive: true });
  const project = managed(root, 'Project.md');
  if (!existsSync(project)) writeFileSync(project, '# 项目约定\n\n记录本仓库的构建与验证入口、模块边界、生成物目录和变更触发规则。先阅读现有 AGENTS.md / Project.md，再补充有证据的项目事实。\n', { flag: 'wx' });
  register(root); return config(root);
}
export function listFiles(root, folder, suffix) {
  const path = managed(root, folder);
  if (!existsSync(path)) return [];
  return readdirSync(path).filter(name => name.endsWith(suffix)).sort().map(name => managed(root, `${folder}/${name}`));
}

// Include tracked and untracked, non-ignored inputs. Task evidence is excluded to avoid self-invalidating receipts.
export function fingerprint(root) {
  const names = execFileSync('git', ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).split('\0').filter(Boolean);
  const digest = createHash('sha256');
  for (const name of [...new Set(names)].sort()) {
    if (['TaskLogs', 'KnowledgeBase', 'Learning'].some(dir => name.startsWith(`${base}/${dir}/`))) continue;
    digest.update(name).update('\0');
    const path = join(root, name);
    let stat;
    try { stat = lstatSync(path); } catch (e) { if (e.code !== 'ENOENT') throw e; digest.update('deleted'); continue; }
    if (stat.isSymbolicLink()) digest.update(readlinkSync(path));
    else if (name === `${base}/project.json`) digest.update(JSON.stringify(json(path).enabledPrompts));
    else if (stat.isDirectory()) {
      if (repo(path) !== realpathSync(path)) digest.update('uninitialized-submodule');
      else { digest.update(git(path, 'rev-parse', 'HEAD')); digest.update(fingerprint(path)); }
    }
    else { digest.update(String(stat.mode & 0o111)); digest.update(readFileSync(path)); }
  }
  return digest.digest('hex');
}
