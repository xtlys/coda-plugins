import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { config, hash, id, inside, json, listFiles, managed, plugin, requireValue, retiredBuiltinIds, save, strings, text } from './store.mjs';

export const builtinIds = ['general', 'cpp'];
const reservedIds = [...builtinIds, ...retiredBuiltinIds];
export const manifest = json(join(plugin, 'upstream/manifest.json'));
export function sourceText(path) {
  const entry = manifest.files.find(f => f.path === path);
  requireValue(entry, `未分发的协议文件：${path}`);
  const content = readFileSync(inside(join(plugin, 'upstream'), path));
  requireValue(hash(content) === entry.sha256, `协议指纹不匹配：${path}`);
  return content.toString('utf8');
}
export function sourceUrl(source) {
  return `${manifest.repository}/blob/${manifest.commit}/${manifest.root}/${source.path}#L${source.start}-L${source.end}`;
}
export function validatePrompt(p, builtin = false) {
  requireValue([1, 2].includes(p.schemaVersion), '规范 schemaVersion 须为 1 或 2');
  id(p.id); text(p.title, 'title', 120);
  requireValue(['general', 'cpp', 'language', 'project'].includes(p.scope), 'scope 须为 general、cpp、language 或 project');
  if (p.scope === 'language') text(p.language, 'language', 120);
  text(p.appliesTo, 'appliesTo');
  if (p.schemaVersion === 1) {
    for (const field of ['prefer', 'avoid', 'checks']) strings(p[field], field);
    strings(p.exceptions, 'exceptions', 0); strings(p.sources, 'sources', 0);
    requireValue(Array.isArray(p.examples) && p.examples.length > 0 && p.examples.length <= 30, '需要正反示例');
    for (const e of p.examples) for (const key of ['good', 'bad', 'why']) text(e[key], `examples.${key}`);
  } else {
    requireValue(Array.isArray(p.sections) && p.sections.length > 0 && p.sections.length <= 100, '需要规范条目');
    const topics = new Set();
    if (builtin || p.topics !== undefined) {
      requireValue(Array.isArray(p.topics) && p.topics.length > 0 && p.topics.length <= 30, '需要主题目录');
      for (const topic of p.topics) {
        id(topic.id); text(topic.title, 'topic.title', 120);
        requireValue(!topics.has(topic.id), '主题 ID 重复'); topics.add(topic.id);
        requireValue(p.sections.some(s => s.topic === topic.id), '主题不能是空目录');
      }
    }
    const ids = new Set();
    for (const s of p.sections) {
      id(s.id); requireValue(!ids.has(s.id), '条目 ID 重复'); ids.add(s.id); text(s.title, 'section.title', 200);
      text(s.body, 'section.body', 100000);
      if (topics.size) requireValue(topics.has(s.topic), '条目必须属于目录中的主题');
      else requireValue(s.topic === undefined, '条目主题需要对应的主题目录');
      if (builtin) {
        requireValue(hash(s.body) === s.sha256, `规范正文指纹不匹配：${s.id}`);
        text(s.context, 'section.context');
        requireValue(Array.isArray(s.sources) && s.sources.length > 0, '需要原文来源');
        for (const source of s.sources) {
          const file = manifest.conventionSources.find(f => f.path === source.path);
          requireValue(file && Number.isInteger(source.start) && Number.isInteger(source.end) && source.start > 0 && source.end >= source.start && source.end <= file.lineCount, '原文行范围无效');
        }
      }
      else {
        requireValue(!s.source, '项目条目使用 body 与 sources，不能冒充内置原文');
        strings(s.sources ?? [], 'section.sources', 0);
      }
    }
  }
  return p;
}
export function builtinPrompts() { return builtinIds.map(key => validatePrompt(json(join(plugin, 'prompts', `${key}.json`)), true)); }
function projectPrompts(root) {
  const ids = new Map();
  return listFiles(root, 'prompts', '.json').map(file => {
    const prompt = validatePrompt(json(file));
    requireValue(!reservedIds.includes(prompt.id), '项目规范不可覆盖内置或已移除的内置 ID');
    requireValue(!ids.has(prompt.id), `项目规范 ID 重复：${prompt.id}（${ids.get(prompt.id)} 与 ${basename(file)}）`);
    ids.set(prompt.id, basename(file));
    return { file, prompt };
  });
}
export function prompts(root) {
  const enabled = root ? config(root).enabledPrompts : [];
  requireValue(Array.isArray(enabled), 'enabledPrompts 须为数组');
  const custom = root ? projectPrompts(root).map(entry => entry.prompt) : [];
  return [...builtinPrompts().map(p => ({ ...p, origin: 'builtin', enabled: enabled.includes(p.id) })),
    ...custom.map(p => ({ ...p, origin: 'project', enabled: enabled.includes(p.id) }))];
}
export function putPrompt(root, p) {
  requireValue(!reservedIds.includes(p.id), '内置规范只由插件开发者维护；请使用新的项目规范 ID');
  validatePrompt(p);
  const keys = p.schemaVersion === 1 ? ['language', 'prefer', 'avoid', 'examples', 'exceptions', 'checks', 'sources'] : ['language', 'topics', 'sections'];
  const canonical = Object.fromEntries(['schemaVersion', 'id', 'title', 'scope', 'appliesTo', ...keys].filter(k => p[k] !== undefined).map(k => [k, p[k]]));
  const existing = projectPrompts(root).find(entry => entry.prompt.id === p.id);
  save(existing?.file ?? managed(root, `prompts/${id(p.id)}.json`), canonical); return canonical;
}
export function enablePrompt(root, key, enable) {
  id(key); requireValue(prompts(root).some(p => p.id === key), `规范不存在：${key}`);
  const cfg = config(root), enabled = new Set(cfg.enabledPrompts);
  if (enable) enabled.add(key); else enabled.delete(key);
  cfg.enabledPrompts = [...enabled]; save(managed(root, 'project.json'), cfg); return cfg;
}
export function renderPrompt(p, topic) {
  if (topic !== undefined) requireValue(p.topics?.some(t => t.id === topic), '主题不存在');
  if (p.schemaVersion === 2) {
    const renderSection = (s, heading) => {
      if (!builtinIds.includes(p.id)) return `${heading} ${s.title}\n\n${s.body}\n\n${(s.sources ?? []).map(v => `- 来源：${v}`).join('\n')}`;
      return `${heading} ${s.title}\n\n适用上下文：${s.context}\n\n${s.sources.map(f => `[上游原文 ${f.path}:${f.start}–${f.end}](${sourceUrl(f)})${f.edited ? '（已删去专属片段）' : ''}`).join(' · ')}\n\n${s.body}`;
    };
    const body = p.topics ? p.topics.filter(t => topic === undefined || t.id === topic).map(t =>
      `## ${t.title}\n\n${p.sections.filter(s => s.topic === t.id).map(s => renderSection(s, '###')).join('\n\n')}`
    ).join('\n\n') : p.sections.map(s => renderSection(s, '##')).join('\n\n');
    return `# ${p.title}\n\n适用范围：${p.appliesTo}\n\n${body}`;
  }
  return `# ${p.title}\n\n适用范围：${p.appliesTo}\n\n## 应该怎样做\n${p.prefer.map(s => `- ${s}`).join('\n')}\n\n## 不要怎样做\n${p.avoid.map(s => `- ${s}`).join('\n')}\n\n## 正反示例\n${p.examples.map(e => `### 示例\n\n好的做法：${e.good}\n\n不好的做法：${e.bad}\n\n原因：${e.why}`).join('\n\n')}\n\n## 例外与覆盖\n${p.exceptions.map(s => `- ${s}`).join('\n')}\n\n## 如何检查\n${p.checks.map(s => `- ${s}`).join('\n')}\n\n## 来源\n${p.sources.map(s => `- ${s}`).join('\n')}\n`;
}
export function promptTemplate(key) {
  return { schemaVersion: 2, id: id(key), title: '项目规范', scope: 'project', appliesTo: '填写适用场景与边界', topics: [{ id: 'design', title: '填写主题名称' }], sections: [{ id: 'decision', topic: 'design', title: '填写决策条目', body: '- Prefer 推荐做法 over 相对应的不良做法。\n  - 写清原因及正反例。\n  - Unless explicitly instructed，写清例外条件。', sources: [] }] };
}
