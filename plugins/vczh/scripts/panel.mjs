import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { config, hash, json, managed, requireValue, retiredBuiltinIds, save } from './store.mjs';
import { builtinPrompts, prompts, renderPrompt } from './prompts.mjs';
import { documents, freshness, legacyDocuments } from './knowledge.mjs';

const names = { knowledge: '知识库', learning: '学习与偏好', archives: '调查归档', prompts: '项目规范', legacy: '旧版资料' };
const short = (s, n = 75) => [...String(s).replace(/[\r\n]/g, ' ')].slice(0, n).join('');
const stat = (label, value) => ({ type: 'stat', label, value: short(value) });
const button = (label, args) => ({ type: 'button', action: 'browse', label: short(label), args });
const card = (title, items, subtitle) => ({ type: 'card', title: short(title), ...(subtitle ? { subtitle: short(subtitle) } : {}), items });
const markdown = text => ({ type: 'markdown', text });
class StaleSelection extends Error {}
function validateView(view) {
  requireValue(view && ['overview', 'builtin', 'project', 'detail'].includes(view.view), '未知页面');
  requireValue(Number.isInteger(view.page ?? 0) && (view.page ?? 0) >= 0 && (view.page ?? 0) <= 100000, '页码无效');
  if (view.key) requireValue(/^[a-f0-9]{64}$/.test(view.key), '项目标识无效');
  if (view.kind) requireValue(Object.hasOwn(names, view.kind), '内容类型无效');
  if (view.id) requireValue(/^[a-z0-9][a-z0-9-]{0,79}$/.test(view.id), '条目标识无效');
  if (view.topic) requireValue(/^[a-z0-9][a-z0-9-]{0,79}$/.test(view.topic), '主题标识无效');
  return view;
}
function registered(state) {
  const folder = join(state, 'projects');
  if (!existsSync(folder)) return [];
  const groups = new Map();
  for (const file of readdirSync(folder).filter(f => /^[a-f0-9]{64}\.json$/.test(f))) {
    let entry;
    try {
      entry = json(join(folder, file));
      requireValue(hash(entry.root) === file.slice(0, -5), '登记路径不匹配');
      entry.key = file.slice(0, -5);
      const cfg = config(entry.root);
      if (cfg.projectId !== entry.projectId) throw new StaleSelection('目录已被其他项目替换');
      entry.name = cfg.name;
      entry.knowledge = documents(entry.root, 'knowledge'); entry.learning = documents(entry.root, 'learning');
      entry.archives = documents(entry.root, 'archives'); entry.legacy = legacyDocuments(entry.root);
      entry.prompts = prompts(entry.root).filter(p => p.origin === 'project');
      const tasksDir = managed(entry.root, 'requests');
      entry.tasks = existsSync(tasksDir) ? readdirSync(tasksDir).filter(name => name.endsWith('.json')).map(name => json(managed(entry.root, `requests/${name}`))) : [];
      entry.stale = [...entry.knowledge, ...entry.learning].filter(d => freshness(entry.root, d) === 'stale').length;
    } catch (e) {
      entry = { ...entry, key: file.slice(0, -5), error: e.message, name: entry?.name ?? '无效登记',
        unavailable: e instanceof StaleSelection || ['ENOENT', 'ENOTDIR'].includes(e.code) };
    }
    const group = groups.get(entry.projectId ?? entry.key) ?? []; group.push(entry); groups.set(entry.projectId ?? entry.key, group);
  }
  // A Git worktree carries the same projectId. Count one readable snapshot, never sum branch copies.
  return [...groups.values()].map(group => {
    group.sort((a, b) => Number(!!a.error) - Number(!!b.error) || (b.registeredAt ?? '').localeCompare(a.registeredAt ?? ''));
    return { ...group[0], worktrees: group.length };
  }).sort((a, b) => a.name.localeCompare(b.name));
}
function pages(items, list, view, size = 5) {
  const page = view.page ?? 0, start = page * size;
  if (page) items.push(button('上一页', { ...view, page: page - 1 }));
  if (start + size < list.length) items.push(button('下一页', { ...view, page: page + 1 }));
  return list.slice(start, start + size);
}
export function panel(state, view = { view: 'overview' }) {
  validateView(view);
  // An installed 2.0 panel can retain a now-removed builtin selection.
  if (view.view === 'builtin' && retiredBuiltinIds.includes(view.id)) view = { view: 'overview' };
  const items = [card('vczh', [button('项目总览', { view: 'overview' }), ...builtinPrompts().map(p => button(p.title, { view: 'builtin', id: p.id }))])];
  if (view.view === 'builtin') {
    const p = builtinPrompts().find(p => p.id === view.id); requireValue(p, '内置规范不存在');
    if (!view.topic) {
      items.push(card(p.title, [markdown(p.appliesTo), stat('主题 / 条目', `${p.topics.length} / ${p.sections.length}`)], '内置 · 由插件开发者维护'));
      for (const topic of pages(items, p.topics, view)) items.push(card(topic.title, [
        markdown(p.sections.filter(s => s.topic === topic.id).map(s => `- ${s.title}`).join('\n')),
        button('阅读规范', { view: 'builtin', id: p.id, topic: topic.id }),
      ]));
    } else {
      const topic = p.topics.find(t => t.id === view.topic); requireValue(topic, '主题不存在');
      items.push(button('返回主题目录', { view: 'builtin', id: p.id }));
      const chunks = renderPrompt(p, topic.id).match(/[\s\S]{1,2200}/gu) ?? [];
      items.push(card(topic.title, pages(items, chunks, view, 1).map(markdown), `${p.title} · 原文片段与来源`));
    }
    return { items };
  }
  const projects = registered(state);
  if (view.view === 'overview') {
    const good = projects.filter(p => !p.error), sum = field => good.reduce((n, p) => n + p[field].length, 0);
    items.push(card('项目知识总览', [stat('已登记项目', projects.length), stat('暂不可读取', projects.length - good.length), stat('知识 / 经验 / 项目规范', `${sum('knowledge')} / ${sum('learning')} / ${sum('prompts')}`), stat('来源已变化', good.reduce((n, p) => n + p.stale, 0)),
      markdown('知识直接读取 .github/KnowledgeBase；学习读取原文 Learning 文件。使用 vczh init 登记。每个项目统计最近登记且仍可读的工作区，不重复累计分支副本。') ]));
    for (const p of pages(items, projects, view)) {
      if (p.error) { items.push(card(p.name, [markdown(`无法读取：${short(p.error, 450)}`)])); continue; }
      items.push(card(p.name, [stat('知识 / 学习文件 / 规范', `${p.knowledge.length} / ${p.learning.length} / ${p.prompts.length}`), stat('进行中 / 已完成 / 已放弃', `${p.tasks.filter(t => ['pending', 'running'].includes(t.status)).length} / ${p.tasks.filter(t => t.status === 'done').length} / ${p.tasks.filter(t => t.status === 'abandoned').length}`), stat('学习条目 / 归档', `${p.learning.reduce((n, d) => n + d.learningCount, 0)} / ${p.archives.length}`), ...Object.entries(names).map(([kind, label]) => button(label, { view: 'project', key: p.key, kind }))], p.root));
    }
  } else {
    const p = projects.find(p => p.key === view.key);
    if (!p || p.unavailable) throw new StaleSelection('工作区不可读或已切换，请返回项目总览');
    requireValue(!p.error, p.error);
    const kind = view.kind ?? 'knowledge', list = p[kind];
    items.push(card(p.name, Object.entries(names).map(([kind, label]) => button(label, { view: 'project', key: p.key, kind }))));
    if (view.view === 'project') {
      if (!list.length) items.push(markdown(`还没有${names[kind]}。可在此项目的对话中请 Agent 创建。`));
      for (const entry of pages(items, list, view)) items.push(card(entry.title, [markdown(short(entry.summary ?? entry.appliesTo, 400)), stat('状态', kind === 'prompts' ? (entry.enabled ? '已启用' : '未启用') : freshness(p.root, entry)), button('查看全文', { view: 'detail', key: p.key, kind, id: entry.id })]));
    } else {
      const entry = list.find(d => d.id === view.id);
      if (!entry) throw new StaleSelection('条目不存在');
      const content = kind === 'prompts' ? renderPrompt(entry) : `${entry.body}\n\n文档：${entry.path}`;
      const chunks = content.match(/[\s\S]{1,2200}/gu) ?? [];
      items.push(card(entry.title, pages(items, chunks, view, 1).map(markdown)));
    }
  }
  return { items };
}
export function readPanel(state) {
  const file = join(state, 'view.json'), view = existsSync(file) ? json(file) : undefined;
  try { return panel(state, view); }
  catch (error) {
    if (!(error instanceof StaleSelection)) throw error;
    rmSync(file, { force: true });
    return panel(state);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const state = process.env.CODA_PLUGIN_STATE; requireValue(state, '缺少 CODA_PLUGIN_STATE');
    const file = join(state, 'view.json');
    if (process.argv.includes('--browse')) save(file, validateView(JSON.parse(process.env.CODA_PANEL_ARGS)));
    else console.log(JSON.stringify(readPanel(state)));
  } catch (e) { console.error(`vczh: ${e.message}`); process.exitCode = 1; }
}
