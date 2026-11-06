import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { plugin, requireValue } from './store.mjs';
import { sourceText } from './prompts.mjs';
import { modes } from './requests.mjs';

export function protocol(mode) {
  if (!mode) return readFileSync(join(plugin, 'skills/vczh/SKILL.md'), 'utf8');
  if (['adapter', 'prompts'].includes(mode)) return readFileSync(join(plugin, `skills/vczh/references/${mode}.md`), 'utf8');
  requireValue(modes.includes(mode), '未知原文协议；使用 ask|investigate|review|refine|kb|kb-refine|direct');
  const adapter = readFileSync(join(plugin, 'skills/vczh/references/adapter.md'), 'utf8');
  const files = ['AGENTS.md', 'copilot-instructions.md', ...(mode === 'direct' ? [] : [`prompts/${mode}.prompt.md`])];
  return `${adapter}\n\n${files.map(path => `\n---\n\n原文文件：${path}\n\n${sourceText(path)}`).join('\n')}`;
}
