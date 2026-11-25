import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { backups, consumeBackup, layerHealth, walkMarkdown } from './assets.mjs';
import { agentArgs, loadSettings, resolveEngineer, rolePrompt } from './roles.mjs';
import { appendGithubOutput, atomic, git, managed, projectGroup, repo, requireValue } from './store.mjs';
import { extractJsonBlock, runCodeVerifiers } from './verify.mjs';

function runCmd(bin, args, options = {}) {
  return execFileSync(bin, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    ...options,
  }).trim();
}

const gh = (...args) => runCmd('gh', args);
function privateGh(...args) {
  const { CODA_THREAD_ID: _thread, ...privateEnv } = process.env;
  return runCmd('gh', args, { env: privateEnv });
}

export function buildRefineContext(root) {
  const earliest = backups(root, 1)[0] ?? null;
  if (!earliest) return { hasArchive: false, archive: null, files: [], health: layerHealth(root) };
  const files = walkMarkdown(root, earliest).map(({ path, body }) => ({
    name: path.slice(earliest.length + 1),
    body,
  }));
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
    knowledgeUpdates: Array.isArray(raw.knowledgeUpdates) ? raw.knowledgeUpdates : [],
  };
}

export function applyProseRefinements(root, diagnosis) {
  const edits = new Map();
  const obsolete = (diagnosis.obsoleteProse ?? []).filter(s => typeof s === 'string' && s.trim()).map(s => s.trim());
  const learning = managed(root, 'learning');
  if (obsolete.length && existsSync(learning)) {
    for (const entry of readdirSync(learning, { withFileTypes: true })) {
      if (!entry.isFile() || !/^Learning_.*\.md$/.test(entry.name)) continue;
      const file = managed(root, `learning/${entry.name}`);
      const content = readFileSync(file, 'utf8');
      const kept = content.split('\n').filter(line => !obsolete.some(rule => line.includes(rule))).join('\n');
      if (kept !== content) edits.set(file, kept);
    }
  }
  for (const note of diagnosis.learningUpdates ?? []) {
    const { file = 'Learning_General.md', text } = typeof note === 'string' ? { text: note } : note ?? {};
    if (typeof text !== 'string' || !text.trim()) continue;
    requireValue(['Learning_General.md', 'Learning_Coding.md', 'Learning_Testing.md'].includes(file), `无效的经验文档：${file}`);
    const target = managed(root, `learning/${file}`);
    const content = edits.get(target) ?? (existsSync(target) ? readFileSync(target, 'utf8') : '');
    const bullet = `- ${text.trim()}`;
    const recorded = new RegExp(`^${RegExp.escape(bullet)}(?: \\[\\d+\\])?[ \\t]*$`, 'm');
    if (!recorded.test(content)) edits.set(target, `${content}${content && !content.endsWith('\n') ? '\n' : ''}${bullet} [1]\n`);
  }
  if (Array.isArray(diagnosis.knowledgeUpdates)) {
    for (const { path, content } of diagnosis.knowledgeUpdates) {
      requireValue(typeof path === 'string' && path.startsWith('knowledge/') && path.endsWith('.md') && typeof content === 'string', '知识更新须包含 knowledge/ 下的 Markdown 路径和正文');
      edits.set(managed(root, path), content);
    }
  }
  for (const [file, content] of edits) atomic(file, content);
}

// Chain refactor engineer commits sequentially onto startHead, then commit L4 prose updates + archive consumption,
// and verify via L2/L3 code verifiers BEFORE anything is pushed or reported complete.
export function executeRefinePlan(root, {
  startHead,
  refineBranch,
  archive,
  choice,
  decisionNote = '',
  diagnosis,
  settings = loadSettings(),
  runner,
  tempDir = process.env.RUNNER_TEMP || join(root, '.dickda'),
}) {
  git(root, 'checkout', '-B', refineBranch, startHead);
  let currentHead = startHead;

  if (choice === 'refactor' && diagnosis.actions?.length) {
    mkdirSync(tempDir, { recursive: true });
    for (const [idx, item] of diagnosis.actions.entries()) {
      const trade = ['architect', 'builder', 'verifier'].includes(item.trade) ? item.trade : 'architect';
      const resolved = resolveEngineer(trade, { difficulty: item.difficulty === 'hard' ? 'hard' : 'normal' }, settings);
      const promptFile = join(tempDir, `refine-exec-${idx}.tmp`);
      writeFileSync(promptFile, [
        rolePrompt(trade),
        `## Refine 落层重构任务（目标层级：${item.layer}）\n标题：${item.title}\n\n${item.task}`,
        decisionNote ? `交互者补充要求：\n${decisionNote}` : '',
        '完成后必须在当前分支产生 Git 提交（不要自行推送远端或开 PR）。',
      ].filter(Boolean).join('\n\n'));

      const args = [
        '--commit', currentHead,
        '--title', `[Refine/${item.layer}] ${item.title}`,
        ...agentArgs(resolved.agent),
        '--json',
        '--prompt-file', promptFile,
      ];
      mkdirSync(managed(root, 'lints'), { recursive: true });
      mkdirSync(managed(root, 'verifiers'), { recursive: true });
      const exec = runner ?? (cmdArgs => spawnSync('coda-agent', cmdArgs, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }));
      const run = exec(args);
      try { rmIfExists(promptFile); } catch {}
      if (run.error) throw run.error;
      requireValue(run.status === 0, `Refine 重构工单「${item.title}」执行失败（退出码 ${run.status}），保留原归档未消费`);
      let reply = null;
      try { reply = JSON.parse(run.stdout); } catch {}
      requireValue(reply?.head, `Refine 重构工单「${item.title}」未返回有效交付提交 SHA，保留原归档未消费`);
      const delivered = git(root, 'rev-parse', '--verify', `${reply.head}^{commit}`);
      const noNewCommit = spawnSync('git', ['-C', root, 'merge-base', '--is-ancestor', delivered, currentHead]).status === 0;
      requireValue(!noNewCommit, `Refine 重构工单「${item.title}」未产生新提交（${delivered}），保留原归档未消费`);
      const isDescendant = spawnSync('git', ['-C', root, 'merge-base', '--is-ancestor', currentHead, delivered]).status === 0;
      requireValue(isDescendant, `Refine 重构工单「${item.title}」返回的提交（${delivered}）不是前序基线（${currentHead}）的严格后代，拒绝丢弃前序改动并保留原归档未消费`);
      git(root, 'checkout', '-B', refineBranch, delivered);
      currentHead = delivered;
    }
  }

  applyProseRefinements(root, diagnosis);
  consumeBackup(root, archive);
  git(root, 'add', '-A', '.dickda');
  requireValue(Boolean(git(root, 'status', '--porcelain', '--', '.dickda')), 'Refine 消费归档后未检测到 .dickda 变更');
  git(root, 'commit', '-m', `chore(dickda): refine ${archive} (${diagnosis.layers.join(',')})`);
  currentHead = git(root, 'rev-parse', 'HEAD');

  const verifyOutcome = runCodeVerifiers(root);
  requireValue(verifyOutcome.passed, `Refine 后的 L2/L3 验证未通过，拒绝持久化并保留原分支归档：\n${verifyOutcome.summary}`);
  return { head: currentHead, verifySummary: verifyOutcome.summary };
}

function rmIfExists(file) {
  if (existsSync(file)) writeFileSync(file, '');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const env = process.env;
    const action = process.argv[2];
    const stateFile = join(env.CODA_ARTIFACTS, 'refine.json');
    const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : null;
    const saveState = next => writeFileSync(stateFile, `${JSON.stringify(next, null, 2)}\n`);
    const settings = loadSettings(env.CODA_PLUGIN_SETTINGS);

    switch (action) {
      case 'collect': {
        if (state) {
          appendGithubOutput({ group: state.group, hasArchive: state.hasArchive, archive: state.archive ?? '' });
          break;
        }
        const root = repo();
        const repoInfo = JSON.parse(gh('repo', 'view', '--json', 'nameWithOwner,defaultBranchRef'));
        const defaultBranch = repoInfo.defaultBranchRef.name;
        const base = (env.BASE || '').trim() || defaultBranch;
        const remote = `https://github.com/${repoInfo.nameWithOwner}.git`;
        git(root, 'fetch', '--quiet', remote, base);
        const baseCommit = git(root, 'rev-parse', 'FETCH_HEAD');

        let startHead = (env.RUN_COMMIT || '').trim() || baseCommit;
        if (env.BRANCH && env.BRANCH.trim() && env.BRANCH.trim() !== base) {
          const b = env.BRANCH.trim();
          const hasLocal = spawnSync('git', ['-C', root, 'rev-parse', '--verify', `refs/heads/${b}^{commit}`]).status === 0;
          if (hasLocal) {
            startHead = git(root, 'rev-parse', '--verify', `refs/heads/${b}^{commit}`);
          } else {
            git(root, 'fetch', '--quiet', remote, b);
            startHead = git(root, 'rev-parse', 'FETCH_HEAD');
          }
        }
        git(root, 'checkout', '--detach', '--force', '--quiet', startHead);

        const ctx = buildRefineContext(root);
        const refineBranch = `dickda/refine-${env.GITHUB_RUN_ID}`;
        if (ctx.hasArchive) {
          git(root, 'push', '--quiet', '--force', '--no-follow-tags', remote, `${startHead}:refs/heads/${refineBranch}`);
        }
        const initial = {
          remote,
          base,
          refineBranch,
          head: startHead,
          group: projectGroup(root),
          ...ctx,
        };
        saveState(initial);
        appendGithubOutput({
          group: initial.group,
          hasArchive: ctx.hasArchive,
          archive: ctx.archive ?? '',
        });
        break;
      }

      case 'diagnose': {
        const root = repo();
        git(root, 'fetch', '--quiet', state.remote, state.refineBranch);
        const head = git(root, 'rev-parse', 'FETCH_HEAD');
        git(root, 'checkout', '--detach', '--force', '--quiet', head);

        const promptFile = join(env.RUNNER_TEMP, 'refine-thinker.md');
        const archiveText = (state.files ?? []).map(f => `### ${f.name}\n\n${f.body}`).join('\n\n');
        const prompt = [
          rolePrompt('thinker'),
          `## Refine 归档复盘输入（归档目录：${state.archive}）\n${archiveText}`,
          `## 当前项目五层健康度\n\`\`\`json\n${JSON.stringify(state.health, null, 2)}\n\`\`\``,
          'learningUpdates 中的字符串写入 Learning_General.md。也可用 {"file":"Learning_Coding.md","text":"经验条文"} 指定 General、Coding 或 Testing 文档。knowledgeUpdates 每项用 {"path":"knowledge/<name>.md","content":"完整正文"} 更新知识文档。',
          `## 输出要求\n评估该归档暴露的痛点是否需要结构性演进或重构，并确定应落实到哪几个层次（L1 架构/接口重构、L2 .dickda/lints 可执行规则、L3 .dickda/verifiers 结果验证器、L4 知识/经验文档更新与旧口头规则瘦身）。在末尾输出 \`\`\`json 块：\n\`\`\`json\n{\n  "needsRefactor": true,\n  "layers": ["L2", "L4"],\n  "summary": "诊断结论摘要",\n  "actions": [{"layer": "L2", "trade": "architect", "difficulty": "normal", "title": "...", "task": "..."}],\n  "obsoleteProse": [],\n  "learningUpdates": [],\n  "knowledgeUpdates": []\n}\n\`\`\``,
        ].join('\n\n');
        writeFileSync(promptFile, prompt);

        const res = spawnSync('coda-agent', [
          '--commit', head,
          '--title', `思考者 Refine 诊断：${state.archive}`,
          ...agentArgs(settings.thinker),
          '--json',
          '--prompt-file', promptFile,
        ], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
        if (res.error) throw res.error;
        requireValue(res.status === 0, `思考者 Refine 诊断退出码 ${res.status}`);
        const reply = JSON.parse(res.stdout);
        const diagnosis = normalizeDiagnosis(extractJsonBlock(reply.answer ?? '') ?? {});
        saveState({ ...state, head, diagnosis });
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
        const root = repo();
        git(root, 'fetch', '--quiet', state.remote, state.refineBranch);
        const startHead = git(root, 'rev-parse', 'FETCH_HEAD');
        const diagnosis = state.diagnosis ?? normalizeDiagnosis({});

        const executed = executeRefinePlan(root, {
          startHead,
          refineBranch: state.refineBranch,
          archive: state.archive,
          choice: state.choice,
          decisionNote: state.decisionNote,
          diagnosis,
          settings,
        });

        git(root, 'push', '--quiet', '--force', '--no-follow-tags', state.remote, `${executed.head}:refs/heads/${state.refineBranch}`);
        saveState({ ...state, head: executed.head, verifySummary: executed.verifySummary });
        appendGithubOutput({ head: executed.head });
        break;
      }

      case 'deliver': {
        const diagnosis = state.diagnosis ?? normalizeDiagnosis({});
        const bodyFile = join(env.CODA_ARTIFACTS, 'refine-pr.md');
        const body = [
          `## Dickda 五层提纯与重构（消费归档 \`${state.archive}\`）`,
          `- **落点层级**：${diagnosis.layers.join('、')}`,
          `- **诊断摘要**：${diagnosis.summary}`,
          state.verifySummary ? `### 验证结果\n${state.verifySummary}` : '',
        ].filter(Boolean).join('\n\n');
        writeFileSync(bodyFile, body);

        const existing = JSON.parse(privateGh('pr', 'list', '--repo', state.remote, '--head', state.refineBranch, '--base', state.base, '--state', 'open', '--json', 'url'));
        const pr = existing[0]?.url || privateGh(
          'pr', 'create', '--repo', state.remote,
          '--base', state.base, '--head', state.refineBranch,
          '--title', `refactor(dickda): refine ${state.archive} (${diagnosis.layers.join(',')})`,
          '--body-file', bodyFile
        );
        saveState({ ...state, pr });
        appendGithubOutput({
          consumed: state.archive,
          commit: state.head,
          pr,
          summary: `已完成 ${state.archive} 的五层提纯（落点：${diagnosis.layers.join('、')}，提交 ${state.head}，PR ${pr}）。`,
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
