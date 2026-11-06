import { readFileSync } from 'node:fs';
import { atomic, config, git, hash, id, inside, listFiles, lock, managed, now, requireValue, strings, text } from './store.mjs';

export const folders = { knowledge: 'KnowledgeBase', learning: 'Learning' };
export function readDoc(file) {
  const content = readFileSync(file, 'utf8'), match = /^<!-- vczh\n([\s\S]*?)\n-->\n([\s\S]*)$/.exec(content);
  requireValue(match, `知识文件格式不正确：${file}`);
  const meta = JSON.parse(match[1]); requireValue(meta.schemaVersion === 1, '知识文件版本不支持');
  return { ...meta, body: match[2].trim() };
}
export function documents(root, kind) {
  requireValue(folders[kind], '类型须为 knowledge 或 learning');
  return listFiles(root, folders[kind], '.md').filter(f => !f.endsWith('/Index.md')).map(readDoc);
}
export function freshness(root, doc) {
  if (doc.status === 'deprecated') return 'deprecated';
  if (doc.status !== 'confirmed') return 'hypothesis';
  return doc.sources.every(s => { try { return hash(readFileSync(inside(root, s.path))) === s.sha256; } catch { return false; } }) ? 'current' : 'stale';
}
const label = value => value.replace(/[\[\]\r\n]/g, ' ');
export function index(root, kind) {
  const entries = documents(root, kind).sort((a, b) => (b.taskIds?.length ?? 0) - (a.taskIds?.length ?? 0) || a.id.localeCompare(b.id));
  atomic(managed(root, `${folders[kind]}/Index.md`), `# ${kind === 'knowledge' ? '知识库' : '经验'}索引\n\n先按摘要选读，再核对来源是否仍然适用。此索引由 vczh 生成。\n\n${entries.map(d => `- [${label(d.title)}](./${d.id}.md) — ${label(d.summary)}；${d.status}；来源任务 ${d.taskIds.length}`).join('\n')}\n`);
}
export function putDocument(root, kind, data) {
  config(root); requireValue(folders[kind], '类型须为 knowledge 或 learning'); id(data.id);
  for (const field of ['title', 'summary', 'body']) text(data[field], field, field === 'body' ? 100000 : 500);
  requireValue(['confirmed', 'hypothesis', 'deprecated'].includes(data.status), 'status 须为 confirmed、hypothesis 或 deprecated');
  requireValue(Array.isArray(data.sources) && data.sources.length > 0 && data.sources.length <= 30, '至少提供一个仓库相对路径来源');
  const sources = data.sources.map(s => { text(s.path, 'source.path', 1000); return { path: s.path, sha256: hash(readFileSync(inside(root, s.path))) }; });
  const taskIds = [...new Set(strings(data.taskIds, 'taskIds', 0).map(id))];
  for (const taskId of taskIds) requireValue(listFiles(root, `TaskLogs/${taskId}`, '.json').some(f => f.endsWith('/task.json')), `来源任务不存在：${taskId}`);
  return lock(root, 'knowledge', () => {
    const old = documents(root, kind).find(d => d.id === data.id);
    const meta = { schemaVersion: 1, id: data.id, title: data.title, summary: data.summary, status: data.status, sources,
      taskIds: [...new Set([...(old?.taskIds ?? []), ...taskIds])], updatedAt: now(), commit: git(root, 'rev-parse', 'HEAD') };
    requireValue(!JSON.stringify(meta).includes('-->'), '知识元数据不能含 HTML 注释终止符');
    atomic(managed(root, `${folders[kind]}/${data.id}.md`), `<!-- vczh\n${JSON.stringify(meta, null, 2)}\n-->\n${data.body.trim()}\n`);
    index(root, kind); return meta;
  });
}
