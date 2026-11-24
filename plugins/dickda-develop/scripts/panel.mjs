import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assetsByKind, layerHealth } from './assets.mjs';
import { builtinPrompts, prompts, renderPrompt } from './prompts.mjs';
import { listRoles, loadSettings } from './roles.mjs';
import { config, hash, json, requireValue, save } from './store.mjs';

const ASSET_NAMES = {
  lints: 'L2 可执行 Lint',
  verifiers: 'L3 结果验证器',
  knowledge: 'L4 知识库',
  learning: 'L4 学习经验',
  archives: '待提纯归档',
  prompts: '项目规范',
  tasks: '任务与五层方案',
};

const short = (s, n = 75) => [...String(s ?? '').replace(/[\r\n]/g, ' ')].slice(0, n).join('');
const stat = (label, value) => ({ type: 'stat', label: short(label), value: short(value) });
const button = (label, args) => ({ type: 'button', action: 'browse', label: short(label), args });
const card = (title, items, subtitle) => ({
  type: 'card',
  title: short(title, 40),
  ...(subtitle ? { subtitle: short(subtitle) } : {}),
  items: items.slice(0, 20),
});
const markdown = text => ({ type: 'markdown', text: [...String(text ?? '')].slice(0, 3800).join('') });

class StaleSelection extends Error {}

function validateView(view) {
  requireValue(view && ['overview', 'roles', 'builtin', 'project', 'detail'].includes(view.view), '未知面板视图');
  requireValue(Number.isInteger(view.page ?? 0) && (view.page ?? 0) >= 0 && (view.page ?? 0) <= 100000, '页码无效');
  if (view.key) requireValue(/^[a-f0-9]{64}$/.test(view.key), '项目标识无效');
  if (view.kind) requireValue(Object.hasOwn(ASSET_NAMES, view.kind), '资产类型无效');
  if (view.id) requireValue(/^[a-z0-9][a-z0-9_-]{0,79}$/.test(view.id), '条目标识无效');
  if (view.topic) requireValue(/^[a-z0-9][a-z0-9_-]{0,79}$/.test(view.topic), '主题标识无效');
  return view;
}

function registeredProjects(stateDir) {
  const folder = join(stateDir, 'projects');
  if (!existsSync(folder)) return [];
  const groups = new Map();

  for (const file of readdirSync(folder).filter(f => /^[a-f0-9]{64}\.json$/.test(f))) {
    let entry;
    try {
      entry = json(join(folder, file));
      requireValue(hash(entry.root) === file.slice(0, -5), '登记路径摘要不匹配');
      entry.key = file.slice(0, -5);
      const cfg = config(entry.root);
      if (cfg.projectId !== entry.projectId) throw new StaleSelection('目录项目已切换');
      entry.name = cfg.name;
      entry.health = layerHealth(entry.root);
      entry.lints = assetsByKind(entry.root, 'lints');
      entry.verifiers = assetsByKind(entry.root, 'verifiers');
      entry.knowledge = assetsByKind(entry.root, 'knowledge');
      entry.learning = assetsByKind(entry.root, 'learning');
      entry.archives = assetsByKind(entry.root, 'archives');
      entry.tasks = assetsByKind(entry.root, 'tasks');
      entry.prompts = prompts(entry.root).filter(p => p.origin === 'project');
    } catch (error) {
      entry = {
        ...entry,
        key: file.slice(0, -5),
        error: error.message,
        name: typeof entry?.name === 'string' && entry.name.trim() ? entry.name : '无效项目登记',
        unavailable: error instanceof StaleSelection || ['ENOENT', 'ENOTDIR'].includes(error.code),
      };
    }
    const list = groups.get(entry.projectId ?? entry.key) ?? [];
    list.push(entry);
    groups.set(entry.projectId ?? entry.key, list);
  }

  return [...groups.values()].map(group => {
    group.sort((a, b) => Number(Boolean(a.error)) - Number(Boolean(b.error)) || (b.registeredAt ?? '').localeCompare(a.registeredAt ?? ''));
    return { ...group[0], worktrees: group.length };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

function paginate(items, list, view, size = 5) {
  const page = view.page ?? 0;
  const start = page * size;
  if (page > 0) items.push(button('上一页', { ...view, page: page - 1 }));
  if (start + size < list.length) items.push(button('下一页', { ...view, page: page + 1 }));
  return list.slice(start, start + size);
}

export function panel(stateDir, view = { view: 'overview' }, settings = loadSettings()) {
  validateView(view);
  const nav = [
    button('五层总览', { view: 'overview' }),
    button('角色编制', { view: 'roles' }),
    ...builtinPrompts().map(p => button(p.title, { view: 'builtin', id: p.id })),
  ];
  const items = [card('Dickda · 五层工程台', nav)];

  if (view.view === 'roles') {
    const roleLines = listRoles(settings).map(r => `- **${r.title}**：${r.display}`).join('\n');
    items.push(card('三角色 · 四工种（两级升级）', [
      stat('自动升级阈值', `连续打回 >= ${settings.escalationThreshold} 次`),
      stat('默认合并方式', settings.mergeMethod),
      markdown(roleLines),
    ], '可在插件设置覆盖任意槽位'));
    return { items };
  }

  if (view.view === 'builtin') {
    const p = builtinPrompts().find(item => item.id === view.id);
    if (!p) throw new StaleSelection('内置规范不存在');
    if (!view.topic) {
      items.push(card(p.title, [
        markdown(p.appliesTo),
        stat('主题 / 条目', `${p.topics.length} / ${p.sections.length}`),
      ], '内置规范底座'));
      for (const topic of paginate(items, p.topics, view)) {
        items.push(card(topic.title, [
          markdown(p.sections.filter(s => s.topic === topic.id).map(s => `- ${s.title}`).join('\n')),
          button('阅读主题全文', { view: 'builtin', id: p.id, topic: topic.id }),
        ]));
      }
    } else {
      const topic = p.topics.find(t => t.id === view.topic);
      if (!topic) throw new StaleSelection('规范主题不存在');
      items.push(button('返回主题目录', { view: 'builtin', id: p.id }));
      const chunks = renderPrompt(p, topic.id).match(/[\s\S]{1,2200}/gu) ?? [];
      items.push(card(topic.title, paginate(items, chunks, view, 1).map(markdown), p.title));
    }
    return { items };
  }

  const projects = registeredProjects(stateDir);
  if (view.view === 'overview') {
    const healthy = projects.filter(p => !p.error);
    const total = fn => healthy.reduce((sum, p) => sum + fn(p), 0);
    items.push(card('跨项目五层健康度', [
      stat('已登记项目', `${healthy.length}（异常 ${projects.length - healthy.length}）`),
      stat('L2 Lints / L3 Verifiers', `${total(p => p.lints.length)} / ${total(p => p.verifiers.length)}`),
      stat('L4 知识 / 待提纯归档', `${total(p => p.knowledge.length)} / ${total(p => p.health.pendingArchives)}`),
      markdown('全部工程、测试与知识资产统一存放于仓库 `.dickda/` 目录；执行 `dickda init` 自动登记。'),
    ]));

    for (const p of paginate(items, projects, view)) {
      if (p.error) {
        items.push(card(p.name, [markdown(`无法读取：${short(p.error, 300)}`)]));
        continue;
      }
      items.push(card(p.name, [
        stat('L2 Lint / L3 代码+实证', `${p.health.l2LintCount} / ${p.health.l3CodeVerifierCount}+${p.health.l3AgentVerifierCount}`),
        stat('L4 知识 / 学习条目 / 归档', `${p.health.l4KnowledgeCount} / ${p.health.l4LearningEntries} / ${p.health.pendingArchives}`),
        ...Object.entries(ASSET_NAMES).map(([kind, label]) => button(label, { view: 'project', key: p.key, kind })),
      ], p.root));
    }
    return { items };
  }

  const project = projects.find(p => p.key === view.key);
  if (!project || project.unavailable) throw new StaleSelection('工作区不可读，返回总览');
  requireValue(!project.error, project.error);
  const kind = view.kind ?? 'lints';
  const list = project[kind] ?? [];

  items.push(card(project.name, Object.entries(ASSET_NAMES).map(([k, label]) => button(label, { view: 'project', key: project.key, kind: k }))));
  if (view.view === 'project') {
    if (!list.length) items.push(markdown(`当前项目尚无「${ASSET_NAMES[kind]}」资产。`));
    for (const entry of paginate(items, list, view)) {
      items.push(card(entry.title, [
        markdown(short(entry.summary ?? entry.appliesTo, 300)),
        stat('状态 / 路径', kind === 'prompts' ? (entry.enabled ? '已启用' : '停用') : (entry.path ?? '')),
        button('查看全文', { view: 'detail', key: project.key, kind, id: entry.id }),
      ]));
    }
  } else {
    const entry = list.find(d => d.id === view.id);
    if (!entry) throw new StaleSelection('资产条目已删除');
    const body = kind === 'prompts' ? renderPrompt(entry) : `${entry.body}\n\n路径：${entry.path}`;
    const chunks = body.match(/[\s\S]{1,2200}/gu) ?? [];
    items.push(card(entry.title, paginate(items, chunks, view, 1).map(markdown)));
  }
  return { items };
}

export function readPanel(stateDir, settings = loadSettings()) {
  const viewFile = join(stateDir, 'view.json');
  const view = existsSync(viewFile) ? json(viewFile) : undefined;
  try {
    return panel(stateDir, view, settings);
  } catch (error) {
    if (!(error instanceof StaleSelection)) throw error;
    rmSync(viewFile, { force: true });
    return panel(stateDir, { view: 'overview' }, settings);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const stateDir = process.env.CODA_PLUGIN_STATE;
    requireValue(stateDir, '缺少 CODA_PLUGIN_STATE');
    const viewFile = join(stateDir, 'view.json');
    if (process.argv.includes('--browse')) {
      save(viewFile, validateView(JSON.parse(process.env.CODA_PANEL_ARGS)));
    } else {
      console.log(JSON.stringify(readPanel(stateDir)));
    }
  } catch (error) {
    console.error(`dickda panel: ${error.message}`);
    process.exitCode = 1;
  }
}
