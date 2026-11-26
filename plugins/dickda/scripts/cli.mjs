#!/usr/bin/env node
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { assetsByKind, backups, layerHealth, remember, runLints } from './assets.mjs';
import { writeDashboard } from './dashboard.mjs';
import { enablePrompt, promptTemplate, prompts, putPrompt, renderPrompt } from './prompts.mjs';
import { listRoles, loadSettings, resolveEngineer, rolePrompt } from './roles.mjs';
import { config, init, json, lock, repo, requireValue } from './store.mjs';
import { runAgentVerifiers, runCodeVerifiers } from './verify.mjs';

const HELP = `dickda init [--root <目录>]
dickda status [--root <目录>]
dickda role list | show <interactor|thinker|lead|architect|builder|verifier> | resolve <architect|builder|verifier> [--tier standard|senior] [--difficulty normal|hard] [--rejections <次数>]
dickda prompt list | show <id> [--topic <主题id>] | put --file <json> | enable <id> | disable <id> | template <新id>
dickda lint [--root <目录>]
dickda verify [--track code|agent|all] [--tier standard|senior] [--difficulty normal|hard] [--root <目录>]
dickda asset list <lints|verifiers|knowledge|learning|archives|tasks> | show <id或相对路径> [--kind <类型>]
dickda remember [--earliest <数量>] [--root <目录>]
dickda dashboard [--output <HTML输出路径>] [--root <目录>]`;

try {
  const { positionals: p, values: v } = parseArgs({
    allowPositionals: true,
    options: Object.fromEntries(
      ['root', 'file', 'topic', 'tier', 'difficulty', 'rejections', 'track', 'kind', 'earliest', 'output']
        .map(k => [k, { type: 'string' }])
    ),
  });

  const settings = loadSettings();
  let output;

  if (!p.length || p[0] === 'help') {
    output = HELP;
  } else if (p[0] === 'role') {
    if (p[1] === 'list') output = listRoles(settings);
    else if (p[1] === 'show') output = rolePrompt(p[2]);
    else if (p[1] === 'resolve') {
      output = resolveEngineer(p[2], {
        tier: v.tier,
        difficulty: v.difficulty || 'normal',
        rejections: Number(v.rejections || 0),
      }, settings);
    }
  } else if (p[0] === 'prompt' && p[1] === 'template') {
    output = promptTemplate(p[2]);
  } else {
    const root = repo(v.root);
    if (p[0] === 'init') {
      output = { root, ...init(root) };
    } else {
      config(root);
      if (p[0] === 'status') {
        output = { root, ...layerHealth(root), roles: listRoles(settings) };
      } else if (p[0] === 'lint') {
        output = runLints(root);
        if (!output.passed) process.exitCode = 1;
      } else if (p[0] === 'verify') {
        const track = v.track ?? 'code';
        requireValue(['code', 'agent', 'all'].includes(track), 'track 须为 code、agent 或 all');
        const codeRes = track === 'agent' ? null : runCodeVerifiers(root);
        const agentRes = track === 'code' ? null : runAgentVerifiers(root, {
          tier: v.tier,
          difficulty: v.difficulty || 'normal',
          settings,
        });
        const passed = (codeRes ? codeRes.passed : true) && (agentRes ? agentRes.passed : true);
        output = { passed, ...(codeRes ? { code: codeRes } : {}), ...(agentRes ? { agent: agentRes } : {}) };
        if (!passed) process.exitCode = 1;
      } else if (p[0] === 'prompt') {
        if (p[1] === 'list') {
          output = prompts(root).map(({ id, title, scope, origin, enabled, appliesTo, topics }) => ({ id, title, scope, origin, enabled, appliesTo, topics }));
        } else if (p[1] === 'show') {
          const found = prompts(root).find(item => item.id === p[2]);
          requireValue(found, `规范不存在：${p[2]}`);
          output = renderPrompt(found, v.topic);
        } else if (p[1] === 'put') {
          output = lock(root, 'prompts', () => putPrompt(root, json(v.file)));
        } else if (['enable', 'disable'].includes(p[1])) {
          output = lock(root, 'prompts', () => enablePrompt(root, p[2], p[1] === 'enable'));
        }
      } else if (p[0] === 'asset') {
        if (p[1] === 'list') {
          output = assetsByKind(root, p[2] ?? v.kind ?? 'knowledge').map(({ body: _body, ...meta }) => meta);
        } else if (p[1] === 'show') {
          const kinds = v.kind ? [v.kind] : ['tasks', 'lints', 'verifiers', 'knowledge', 'learning', 'archives'];
          const all = kinds.flatMap(k => assetsByKind(root, k));
          const found = all.find(d => d.id === p[2] || d.path === p[2] || d.title === p[2]);
          requireValue(found, `资产不存在：${p[2]}`);
          output = found.body;
        }
      } else if (p[0] === 'remember') {
        output = v.earliest ? backups(root, Number(v.earliest)) : remember(root);
      } else if (p[0] === 'dashboard') {
        const target = resolve(v.output ?? join(root, '.dickda/dashboard.tmp.html'));
        output = writeDashboard(root, target, settings);
      }
    }
  }

  requireValue(output !== undefined, HELP);
  process.stdout.write(typeof output === 'string' ? `${output}\n` : `${JSON.stringify(output, null, 2)}\n`);
} catch (error) {
  console.error(`dickda: ${error.message}`);
  process.exitCode = 1;
}
