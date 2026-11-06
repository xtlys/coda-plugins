import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename } from 'node:path';
import { atomic, hash, inside, lock, requireValue } from './store.mjs';

export function readDoc(file, path) {
  const content = readFileSync(file, 'utf8');
  const match = /^<!-- vczh\n([\s\S]*?)\n-->\n([\s\S]*)$/.exec(content);
  const meta = match ? JSON.parse(match[1]) : {};
  const body = match ? match[2] : content;
  const title = meta.title ?? body.match(/^# (?![!])(.+)$/m)?.[1] ?? basename(file, '.md');
  return { ...meta, id: hash(path), title, path, format: match ? 'legacy' : 'native', body,
    summary: meta.summary ?? path, sources: meta.sources ?? [], taskIds: meta.taskIds ?? [],
    learningCount: [...body.matchAll(/^- .+ \[(\d+)\]\s*$/gm)].length };
}
function walk(root, folder) {
  const dir = inside(root, folder);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const path = `${folder}/${entry.name}`;
    if (entry.isSymbolicLink()) return [];
    if (entry.isDirectory()) return walk(root, path);
    return entry.isFile() && entry.name.endsWith('.md') ? [readDoc(inside(root, path), path)] : [];
  });
}
export function documents(root, kind) {
  requireValue(['knowledge', 'learning', 'archives'].includes(kind), '类型须为 knowledge、learning 或 archives');
  if (kind === 'knowledge') return walk(root, '.github/KnowledgeBase').filter(d => d.path !== '.github/KnowledgeBase/Learning.md');
  const learning = walk(root, '.github/Learning');
  if (kind === 'archives') return learning.filter(d => /^\.github\/Learning\/\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\//.test(d.path));
  const shared = '.github/KnowledgeBase/Learning.md';
  return [...(existsSync(inside(root, shared)) ? [readDoc(inside(root, shared), shared)] : []), ...learning.filter(d => !/^\.github\/Learning\/\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\//.test(d.path))];
}
export function legacyDocuments(root) {
  return ['KnowledgeBase', 'Learning'].flatMap(folder => walk(root, `.github/vczh/${folder}`));
}
export function freshness(root, doc) {
  if (doc.format === 'native') return '原文格式';
  if (doc.status === 'deprecated') return 'deprecated';
  if (doc.status !== 'confirmed') return 'hypothesis';
  return doc.sources.every(s => { try { return hash(readFileSync(inside(root, s.path))) === s.sha256; } catch { return false; } }) ? 'current' : 'stale';
}
export function backups(root, count = 1) {
  requireValue(Number.isInteger(count) && count > 0 && count <= 10000, 'earliest 数量须为 1–10000');
  const folder = inside(root, '.github/Learning');
  if (!existsSync(folder)) return [];
  return readdirSync(folder, { withFileTypes: true }).filter(e => e.isDirectory() && /^\d{4}(-\d{2}){5}$/.test(e.name))
    .map(e => `.github/Learning/${e.name}`).sort().slice(0, count);
}
export function remember(root, time = new Date()) {
  return lock(root, 'remember', () => {
    const path = inside(root, '.github/TaskLogs/Copilot_Investigate.md');
    const content = readFileSync(path, 'utf8');
    if (content.replace(/^\uFEFF/, '').trim() === '# !!!INVESTIGATE!!!') return { archived: false };
    let date = new Date(time), target;
    requireValue(Number.isFinite(date.getTime()), '归档时间无效');
    do {
      const parts = [date.getFullYear(), date.getMonth() + 1, date.getDate(), date.getHours(), date.getMinutes(), date.getSeconds()];
      target = `.github/Learning/${parts.map((n,i) => String(n).padStart(i ? 2 : 4, '0')).join('-')}/Copilot_Investigate.md`;
      date = new Date(date.getTime() + 1000);
    } while (existsSync(inside(root, target)));
    atomic(inside(root, target), content);
    atomic(path, '# !!!INVESTIGATE!!!\n');
    return { archived: true, path: target };
  });
}
