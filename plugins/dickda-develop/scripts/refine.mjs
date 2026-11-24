import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { backups, consumeBackup, layerHealth } from './assets.mjs';
import { agentArgs, loadSettings, resolveEngineer, rolePrompt } from './roles.mjs';
import { appendGithubOutput, atomic, inside, managed, projectGroup, repo, requireValue } from './store.mjs';
import { extractJsonBlock } from './verify.mjs';

export function buildRefineContext(root) {
  const earliest = backups(root, 1)[0] ?? null;
  if (!earliest) return { hasArchive: false, archive: null, files: [], health: layerHealth(root) };
  const dir = inside(root, earliest);
  const files = readdirSync(dir)
    .filter(name => name.endsWith('.md'))
    .sort()
    .map(name => ({ name, body: readFileSync(join(dir, name), 'utf8') }));
  return {
    hasArchive: true,
    archive: earliest,
    files,
    health: layerHealth(root),
  };
}

export function normalizeDiagnosis(raw = {}) {
  const validLayers = ['L1', 'L2', 'L3', 'L4'];
  const layers = Array.isArray(raw.layers) ? raw.layers.filter(l => validLayers.includes(l)) : [];
  return {
    needsRefactor: Boolean(raw.needsRefactor && layers.some(l => ['L1', 'L2', 'L3'].includes(l))),
    layers: layers.length ? layers : ['L4'],
    summary: String(raw.summary || '归档复盘完成').trim(),
    actions: Array.isArray(raw.actions) ? raw.actions : [],
    obsoleteProse: Array.isArray(raw.obsoleteProse) ? raw.obsoleteProse : [],
    learningUpdates: Array.isArray(raw.learningUpdates) ? raw.learningUpdates : [],
  };
}

export function applyProseRefinements(root, diagnosis) {
  const target = managed(root, 'learning/Learning_General.md');
  if (!existsSync(target)) return;
  let content = readFileSync(target, 'utf8');
  for (const obsolete of diagnosis.obsoleteProse ?? []) {
    if (typeof obsolete === 'string' && obsolete.trim()) {
      content = content.split(/\r?\n/).filter(line => !line.includes(obsolete.trim())).join('\n');
    }
  }
  for (const note of diagnosis.learningUpdates ?? []) {
    if (typeof note === 'string' && note.trim() && !content.includes(note.trim())) {
      content = `${content.trimEnd()}\n- ${note.trim()} [1]\n`;
    }
  }
  atomic(target, `${content.trimEnd()}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const env = process.env;
    const action = process.argv[2];
    const stateFile = join(env.CODA_ARTIFACTS, 'refine.json');
    const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : {};
    const saveState = next => writeFileSync(stateFile, `${JSON.stringify(next, null, 2)}\n`);
    const settings = loadSettings(env.CODA_PLUGIN_SETTINGS);

    switch (action) {
      case 'collect': {
        const root = repo(env.ROOT || process.cwd());
        const ctx = buildRefineContext(root);
        const next = { root, group: projectGroup(root), ...ctx };
        saveState(next);
        appendGithubOutput({
          group: next.group,
          hasArchive: ctx.hasArchive,
          archive: ctx.archive ?? '',
        });
        break;
      }

      case 'diagnose': {
        const root = state.root || repo();
        const promptFile = join(env.RUNNER_TEMP, 'refine-thinker.md');
        const archiveText = (state.files ?? []).map(f => `### ${f.name}\n\n${f.body}`).join('\n\n');
        const prompt = [
          rolePrompt('thinker'),
          `## Refine 归档复盘输入（归档目录：${state.archive}）\n${archiveText}`,
          `## 当前项目五层健康度\n\`\`\`json\n${JSON.stringify(state.health, null, 2)}\n\`\`\``,
          `## 输出要求\n评估该归档暴露的痛点是否需要结构性演进或重构，并确定应落实到哪几个层次（L1 架构/接口重构、L2 .dickda/lints 可执行规则、L3 .dickda/verifiers 结果验证器、L4 知识/经验文档更新与旧口头规则瘦身）。在末尾输出 \`\`\`json 块：\n\`\`\`json\n{\n  "needsRefactor": true,\n  "layers": ["L2", "L4"],\n  "summary": "诊断结论摘要",\n  "actions": [{"layer": "L2", "trade": "architect", "difficulty": "normal", "title": "...", "task": "..."}],\n  "obsoleteProse": [],\n  "learningUpdates": []\n}\n\`\`\``,
        ].join('\n\n');
        writeFileSync(promptFile, prompt);

        const res = spawnSync('coda-agent', [
          '--title', `思考者 Refine 诊断：${state.archive}`,
          ...agentArgs(settings.thinker),
          '--json',
          '--prompt-file', promptFile,
        ], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
        if (res.error) throw res.error;
        requireValue(res.status === 0, `思考者 Refine 诊断退出码 ${res.status}`);
        const reply = JSON.parse(res.stdout);
        const diagnosis = normalizeDiagnosis(extractJsonBlock(reply.answer ?? '') ?? {});
        saveState({ ...state, diagnosis });
        appendGithubOutput({
          needsRefactor: diagnosis.needsRefactor,
          layers: diagnosis.layers.join('、'),
          summary: diagnosis.summary,
          plan: JSON.stringify(diagnosis.actions, null, 2),
        });
        break;
      }

      case 'decide': {
        const reply = JSON.parse(env.DECISION || '{}');
        const choice = reply.choice || 'prose';
        saveState({ ...state, choice, decisionNote: reply.note ?? '' });
        appendGithubOutput({ route: choice });
        break;
      }

      case 'execute': {
        const root = state.root || repo();
        const diagnosis = state.diagnosis ?? normalizeDiagnosis({});
        if (state.choice === 'refactor' && diagnosis.actions.length) {
          for (const [idx, item] of diagnosis.actions.entries()) {
            const trade = ['architect', 'builder', 'verifier'].includes(item.trade) ? item.trade : 'architect';
            const resolved = resolveEngineer(trade, { difficulty: item.difficulty === 'hard' ? 'hard' : 'normal' }, settings);
            const promptFile = join(env.RUNNER_TEMP, `refine-exec-${idx}.md`);
            mkdirSync(env.RUNNER_TEMP, { recursive: true });
            writeFileSync(promptFile, `${rolePrompt(trade)}\n\n## Refine 落层重构任务（目标层级：${item.layer}）\n标题：${item.title}\n\n${item.task}\n${state.decisionNote ? `\n交互者补充要求：\n${state.decisionNote}\n` : ''}`);
            const run = spawnSync('coda-agent', [
              '--title', `[Refine/${item.layer}] ${item.title}`,
              ...agentArgs(resolved.agent),
              '--json',
              '--prompt-file', promptFile,
            ], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
            if (run.error) throw run.error;
            requireValue(run.status === 0, `Refine 重构工单 ${item.title} 执行失败`);
          }
        }
        applyProseRefinements(root, diagnosis);
        consumeBackup(root, state.archive);
        appendGithubOutput({
          consumed: state.archive,
          summary: `已完成 ${state.archive} 的五层提纯（落点：${diagnosis.layers.join('、')}）。`,
        });
        break;
      }

      default:
        throw new Error(`未知 dickda-refine 步骤：${action}`);
    }
  } catch (error) {
    console.error(`dickda-refine: ${error.message}`);
    process.exitCode = 1;
  }
}
