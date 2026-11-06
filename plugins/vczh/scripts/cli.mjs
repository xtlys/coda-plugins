#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { config, id, init, json, lock, plugin, register, repo, requireValue } from './store.mjs';
import { builtinPrompts, enablePrompt, prompts, putPrompt, renderPrompt } from './prompts.mjs';
import { documents, freshness, putDocument } from './knowledge.mjs';
import { check, record, revise, start, task } from './tasks.mjs';

const help = `vczh protocol [repro|proposal|implementation|review|refine|delivery|knowledge|prompts]
vczh init [--root <工作目录>]
vczh prompt list|show <id>|put --file <json>|enable <id>|disable <id>|template <新id>
vczh kb list|show <id>|put --kind knowledge|learning --file <json>
vczh task start --title <标题> --file <需求文本> [--delivery local|pull-request]
vczh task show <id> | record <id> --file <证据json> | revise <id> --reason <理由>
vczh check <task-id> -- <命令> <参数...>
所有项目命令支持 --root；完成阶段由 BPMN 核验并推进。先 init；无需覆盖 AGENTS.md。`;
try {
  const argv = process.argv.slice(2), split = argv.indexOf('--');
  const command = split < 0 ? [] : argv.slice(split + 1);
  const { positionals: p, values: v } = parseArgs({ args: split < 0 ? argv : argv.slice(0, split), allowPositionals: true,
    options: Object.fromEntries(['root', 'file', 'title', 'delivery', 'kind', 'reason'].map(k => [k, { type: 'string' }])) });
  let output;
  if (!p.length || p[0] === 'help') output = help;
  else if (p[0] === 'protocol') {
    const name = p[1] ?? 'SKILL'; requireValue(['SKILL', 'repro', 'proposal', 'implementation', 'review', 'refine', 'delivery', 'knowledge', 'prompts'].includes(name), '未知协议章节');
    output = readFileSync(join(plugin, 'skills/vczh', name === 'SKILL' ? 'SKILL.md' : `references/${name}.md`), 'utf8');
  } else if (p[0] === 'prompt' && p[1] === 'template') {
    output = { ...builtinPrompts()[0], id: id(p[2]), title: '项目规范标题', scope: 'project', appliesTo: '填写适用模块与触发场景', prefer: ['填写应该采用的做法与理由'], avoid: ['填写同一决策边界内应避免的做法'], examples: [{ good: '可执行的正例', bad: '相对应的反例', why: '两者的差别和判断依据' }], exceptions: ['用户明确要求与项目契约优先'], checks: ['可以观察或验证的完成标准'], sources: [] };
  } else {
    const root = repo(v.root);
    if (p[0] === 'init') output = { root, ...init(root) };
    else {
      config(root); register(root);
      if (p[0] === 'prompt') {
        if (p[1] === 'list') output = prompts(root).map(({ id, title, scope, origin, enabled, appliesTo }) => ({ id, title, scope, origin, enabled, appliesTo }));
        else if (p[1] === 'show') { const found = prompts(root).find(r => r.id === p[2]); requireValue(found, '规范不存在'); output = renderPrompt(found); }
        else if (p[1] === 'put') output = lock(root, 'prompts', () => putPrompt(root, json(v.file)));
        else if (['enable', 'disable'].includes(p[1])) output = lock(root, 'prompts', () => enablePrompt(root, p[2], p[1] === 'enable'));
      } else if (p[0] === 'kb') {
        const kind = v.kind ?? 'knowledge';
        if (p[1] === 'list') output = documents(root, kind).map(({ body, ...d }) => ({ ...d, freshness: freshness(root, d) }));
        if (p[1] === 'show') { const found = documents(root, kind).find(d => d.id === p[2]); requireValue(found, '知识条目不存在'); output = found; }
        if (p[1] === 'put') output = putDocument(root, kind, json(v.file));
      } else if (p[0] === 'task') {
        if (p[1] === 'start') output = start(root, v.title, readFileSync(v.file, 'utf8'), v.delivery);
        if (p[1] === 'show') output = task(root, p[2]);
        if (p[1] === 'record') output = record(root, p[2], json(v.file));
        if (p[1] === 'revise') output = revise(root, p[2], v.reason);
      } else if (p[0] === 'check') { output = check(root, p[1], command); process.exitCode = output.exitCode === 0 && !output.error ? 0 : 1; }
      requireValue(output !== undefined, help);
    }
  }
  process.stdout.write(typeof output === 'string' ? `${output}\n` : `${JSON.stringify(output, null, 2)}\n`);
} catch (error) { console.error(`vczh: ${error.message}`); process.exitCode = 1; }
