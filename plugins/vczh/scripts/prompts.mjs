import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config, hash, id, inside, json, listFiles, managed, plugin, requireValue, save, strings, text } from './store.mjs';

export const builtinIds = ['general', 'cpp', 'workflow', 'vczh-project'];
export const manifest = json(join(plugin, 'upstream/manifest.json'));
export function sourceText(path) {
  const entry = manifest.files.find(f => f.path === path);
  requireValue(entry, `未登记的原文：${path}`);
  const content = readFileSync(inside(join(plugin, 'upstream'), path));
  requireValue(hash(content) === entry.sha256, `原文指纹不匹配：${path}`);
  return content.toString('utf8');
}
export function excerpt(source) {
  const lines = sourceText(source.path).match(/[^\n]*\n|[^\n]+$/g) ?? [];
  requireValue(Number.isInteger(source.start) && Number.isInteger(source.end) && source.start > 0 && source.end >= source.start && source.end <= lines.length, '原文行范围无效');
  return lines.slice(source.start - 1, source.end).join('');
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
    const ids = new Set();
    for (const s of p.sections) {
      id(s.id); requireValue(!ids.has(s.id), '条目 ID 重复'); ids.add(s.id); text(s.title, 'section.title', 200);
      if (builtin) { excerpt(s.source); text(s.context, 'section.context'); }
      else {
        requireValue(!s.source, '项目条目使用 body 与 sources，不能冒充内置原文');
        text(s.body, 'section.body', 100000);
        strings(s.sources ?? [], 'section.sources', 0);
      }
    }
  }
  return p;
}
export function builtinPrompts() { return builtinIds.map(key => validatePrompt(json(join(plugin, 'prompts', `${key}.json`)), true)); }
export function prompts(root) {
  const enabled = root ? config(root).enabledPrompts : [];
  requireValue(Array.isArray(enabled), 'enabledPrompts 须为数组');
  const custom = root ? listFiles(root, 'prompts', '.json').map(file => validatePrompt(json(file))) : [];
  for (const p of custom) requireValue(!builtinIds.includes(p.id), '项目规范不可覆盖内置 ID');
  return [...builtinPrompts().map(p => ({ ...p, origin: 'builtin', enabled: enabled.includes(p.id) })),
    ...custom.map(p => ({ ...p, origin: 'project', enabled: enabled.includes(p.id) }))];
}
export function putPrompt(root, p) {
  requireValue(!builtinIds.includes(p.id), '内置规范只由插件开发者维护；请使用新的项目规范 ID');
  validatePrompt(p);
  const keys = p.schemaVersion === 1 ? ['prefer', 'avoid', 'examples', 'exceptions', 'checks', 'sources'] : ['language', 'sections'];
  const canonical = Object.fromEntries(['schemaVersion', 'id', 'title', 'scope', 'appliesTo', ...keys].filter(k => p[k] !== undefined).map(k => [k, p[k]]));
  save(managed(root, `prompts/${id(p.id)}.json`), canonical); return canonical;
}
export function enablePrompt(root, key, enable) {
  id(key); requireValue(prompts(root).some(p => p.id === key), `规范不存在：${key}`);
  const cfg = config(root), enabled = new Set(cfg.enabledPrompts);
  if (enable) enabled.add(key); else enabled.delete(key);
  cfg.enabledPrompts = [...enabled]; save(managed(root, 'project.json'), cfg); return cfg;
}
export function renderPrompt(p) {
  if (p.schemaVersion === 2) return `# ${p.title}\n\n适用范围：${p.appliesTo}\n\n` + p.sections.map(s => {
    if (!s.source) return `## ${s.title}\n\n${s.body}\n\n${(s.sources ?? []).map(v => `- 来源：${v}`).join('\n')}`;
    return `## ${s.title}\n\n适用上下文：${s.context}\n\n[上游原文 ${s.source.path}:${s.source.start}–${s.source.end}](${sourceUrl(s.source)})\n\n${excerpt(s.source)}`;
  }).join('\n\n');
  return `# ${p.title}\n\n适用范围：${p.appliesTo}\n\n## 应该怎样做\n${p.prefer.map(s => `- ${s}`).join('\n')}\n\n## 不要怎样做\n${p.avoid.map(s => `- ${s}`).join('\n')}\n\n## 正反示例\n${p.examples.map(e => `### 示例\n\n好的做法：${e.good}\n\n不好的做法：${e.bad}\n\n原因：${e.why}`).join('\n\n')}\n\n## 例外与覆盖\n${p.exceptions.map(s => `- ${s}`).join('\n')}\n\n## 如何检查\n${p.checks.map(s => `- ${s}`).join('\n')}\n\n## 来源\n${p.sources.map(s => `- ${s}`).join('\n')}\n`;
}
export function promptTemplate(key) {
  return { schemaVersion: 2, id: id(key), title: '项目规范', scope: 'project', appliesTo: '填写适用场景与边界', sections: [{ id: 'decision', title: '填写决策主题', body: '- Prefer 推荐做法 over 相对应的不良做法。\n  - 写清原因及正反例。\n  - Unless explicitly instructed，写清例外条件。', sources: [] }] };
}
