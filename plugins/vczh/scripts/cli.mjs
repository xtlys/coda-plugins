#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { config, init, json, lock, register, repo, requireValue } from './store.mjs';
import { enablePrompt, prompts, putPrompt, renderPrompt, promptTemplate, sourceText, manifest } from './prompts.mjs';
import { documents, legacyDocuments, backups, remember } from './knowledge.mjs';
import { abandonRequest, getRequest, route, startRequest } from './requests.mjs';
import { protocol } from './protocol.mjs';

const help = `vczh protocol [ask|investigate|review|refine|kb|kb-refine|direct|adapter|prompts|develop]
vczh source list|<上游相对路径>
vczh init [--root <工作目录>]
vczh route --file <最新请求> [--intent coding|research|maintenance] [--task-file <相对路径>]
vczh request start --file <最新请求> [--intent ...] [--task-file ...]
vczh request show <id> [--run-id <当前运行>]
vczh request abandon <id> --reason <原因> [--run-status <原运行已结束的 workflow_status JSON 文件>]
vczh remember [--earliest <数量>]
vczh prompt list|show <id> [--topic <主题id>]|put --file <json>|enable <id>|disable <id>|template <新id>
vczh kb list|show <id> [--kind knowledge|learning|archives|legacy]
所有项目命令支持 --root。知识和学习文件使用原生 Markdown，由对应原文 prompt 编辑。`;
try {
  const { positionals: p, values: v } = parseArgs({ allowPositionals: true,
    options: Object.fromEntries(['root', 'file', 'kind', 'intent', 'task-file', 'earliest', 'topic', 'run-id', 'run-status', 'reason'].map(k => [k, { type: 'string' }])) });
  let output;
  if (!p.length || p[0] === 'help') output = help;
  else if (p[0] === 'protocol') output = protocol(p[1]);
  else if (p[0] === 'source') output = p[1] === 'list' ? manifest : sourceText(p[1]);
  else if (p[0] === 'prompt' && p[1] === 'template') output = promptTemplate(p[2]);
  else {
    const root = repo(v.root);
    if (p[0] === 'route') output = route(root, readFileSync(v.file, 'utf8'), { intent: v.intent, taskFile: v['task-file'] });
    else if (p[0] === 'init') output = { root, ...init(root) };
    else {
      config(root); register(root);
      if (p[0] === 'prompt') {
        if (p[1] === 'list') output = prompts(root).map(({ id, title, scope, origin, enabled, appliesTo, topics }) => ({ id, title, scope, origin, enabled, appliesTo, topics }));
        else if (p[1] === 'show') { const found = prompts(root).find(r => r.id === p[2]); requireValue(found, '规范不存在'); output = renderPrompt(found, v.topic); }
        else if (p[1] === 'put') output = lock(root, 'prompts', () => putPrompt(root, json(v.file)));
        else if (['enable', 'disable'].includes(p[1])) output = lock(root, 'prompts', () => enablePrompt(root, p[2], p[1] === 'enable'));
      } else if (p[0] === 'kb') {
        const list = v.kind === 'legacy' ? legacyDocuments(root) : documents(root, v.kind ?? 'knowledge');
        if (p[1] === 'list') output = list.map(({ body, ...d }) => d);
        if (p[1] === 'show') { const found = list.find(d => d.id === p[2] || d.path === p[2]); requireValue(found, '文档不存在'); output = found.body; }
      } else if (p[0] === 'request') {
        if (p[1] === 'start') output = startRequest(root, readFileSync(v.file, 'utf8'), { intent: v.intent, taskFile: v['task-file'] });
        if (p[1] === 'show') output = getRequest(root, p[2], v['run-id']);
        if (p[1] === 'abandon') output = abandonRequest(root, p[2], { reason: v.reason, runStatus: v['run-status'] ? json(v['run-status']) : undefined });
      } else if (p[0] === 'remember') output = v.earliest ? backups(root, Number(v.earliest)) : remember(root);
      requireValue(output !== undefined, help);
    }
  }
  process.stdout.write(typeof output === 'string' ? `${output}\n` : `${JSON.stringify(output, null, 2)}\n`);
} catch (error) { console.error(`vczh: ${error.message}`); process.exitCode = 1; }
