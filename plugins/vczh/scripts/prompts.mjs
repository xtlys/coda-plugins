import { join } from 'node:path';
import { config, id, json, listFiles, managed, plugin, requireValue, save, strings, text } from './store.mjs';

export function validatePrompt(p) {
  requireValue(p.schemaVersion === 1, '规范 schemaVersion 须为 1'); id(p.id); text(p.title, 'title', 120);
  requireValue(['general', 'cpp', 'project'].includes(p.scope), 'scope 须为 general、cpp 或 project');
  text(p.appliesTo, 'appliesTo');
  for (const field of ['prefer', 'avoid', 'checks']) strings(p[field], field);
  strings(p.exceptions, 'exceptions', 0); strings(p.sources, 'sources', 0);
  requireValue(Array.isArray(p.examples) && p.examples.length > 0 && p.examples.length <= 30, '需要正反示例');
  for (const e of p.examples) for (const key of ['good', 'bad', 'why']) text(e[key], `examples.${key}`);
  return p;
}
export function builtinPrompts() { return ['general', 'cpp'].map(key => validatePrompt(json(join(plugin, 'prompts', `${key}.json`)))); }
export function prompts(root) {
  const enabled = root ? config(root).enabledPrompts : [];
  requireValue(Array.isArray(enabled), 'enabledPrompts 须为数组');
  return [...builtinPrompts().map(p => ({ ...p, origin: 'builtin', enabled: enabled.includes(p.id) })),
    ...(root ? listFiles(root, 'prompts', '.json').map(file => ({ ...validatePrompt(json(file)), origin: 'project', enabled: enabled.includes(json(file).id) })) : [])];
}
export function putPrompt(root, p) {
  validatePrompt(p);
  requireValue(!builtinPrompts().some(b => b.id === p.id), '内置规范只由插件开发者维护；请使用新的项目规范 ID');
  const canonical = Object.fromEntries(['schemaVersion', 'id', 'title', 'scope', 'appliesTo', 'prefer', 'avoid', 'examples', 'exceptions', 'checks', 'sources'].map(k => [k, p[k]]));
  save(managed(root, `prompts/${id(p.id)}.json`), canonical); return canonical;
}
export function enablePrompt(root, key, enable) {
  id(key); requireValue(prompts(root).some(p => p.id === key), `规范不存在：${key}`);
  const cfg = config(root), enabled = new Set(cfg.enabledPrompts);
  if (enable) enabled.add(key); else enabled.delete(key);
  cfg.enabledPrompts = [...enabled]; save(managed(root, 'project.json'), cfg); return cfg;
}
export function renderPrompt(p) {
  return `# ${p.title}\n\n适用范围：${p.appliesTo}\n\n## 应该怎样做\n${p.prefer.map(s => `- ${s}`).join('\n')}\n\n## 不要怎样做\n${p.avoid.map(s => `- ${s}`).join('\n')}\n\n## 正反示例\n${p.examples.map(e => `### 示例\n\n好的做法：${e.good}\n\n不好的做法：${e.bad}\n\n原因：${e.why}`).join('\n\n')}\n\n## 例外与覆盖\n${p.exceptions.map(s => `- ${s}`).join('\n')}\n\n## 如何检查\n${p.checks.map(s => `- ${s}`).join('\n')}\n\n## 来源\n${p.sources.map(s => `- ${s}`).join('\n')}\n`;
}
