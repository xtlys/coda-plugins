import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkApprovalPr, mergeApprovedPr, privateGh } from './approval.mjs';
import { backups, consumeBackup, layerHealth, walkMarkdown } from './assets.mjs';
import { checkRunsText, jsonList, openMusts, reviewRange, reviewVerdict } from './review.mjs';
import { agentArgs, effectiveSettings, loadSettings, resolveEngineer, rolePrompt } from './roles.mjs';
import { appendGithubOutput, atomic, git, inside, managed, projectGroup, remoteGit, repo, requireValue, save } from './store.mjs';
import { extractJsonBlock, runCodeVerifiers } from './verify.mjs';

function fetchHead(root, remote, branch) {
  remoteGit(root, 'fetch', '--quiet', remote, `refs/heads/${branch}`);
  return git(root, 'rev-parse', 'FETCH_HEAD');
}

function isAncestor(root, ancestor, head) {
  return spawnSync('git', ['-C', root, 'merge-base', '--is-ancestor', ancestor, head]).status === 0;
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
    requireValue(typeof file === 'string' && /^Learning_[A-Za-z0-9][A-Za-z0-9_-]{0,79}\.md$/.test(file), `无效的经验文档：${file}`);
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
  repair,
  settings = loadSettings(),
  runner,
  tempDir = process.env.RUNNER_TEMP || join(root, '.dickda'),
}) {
  git(root, 'checkout', '-B', refineBranch, startHead);
  let currentHead = startHead;

  // A failed initial execution has published no candidate. Replay its selected actions and consume the archive once.
  const consume = !repair || existsSync(inside(root, archive));
  let jobs = consume && choice === 'refactor' ? diagnosis.actions ?? [] : [];
  if (repair && !jobs.length) {
    const owner = choice === 'refactor' ? diagnosis.actions?.at(-1) : null;
    jobs = [{ trade: owner?.trade || 'builder', difficulty: owner?.difficulty, layer: diagnosis.layers.join('、'), title: '修复提纯提交', task: diagnosis.summary }];
  }
  if (jobs.length) {
    mkdirSync(tempDir, { recursive: true });
    for (const [idx, item] of jobs.entries()) {
      const trade = ['architect', 'builder', 'verifier'].includes(item.trade) ? item.trade : 'architect';
      const resolved = resolveEngineer(trade, { difficulty: item.difficulty === 'hard' ? 'hard' : 'normal', rejections: repair?.attempts }, settings);
      const promptFile = join(tempDir, `refine-exec-${idx}.tmp`);
      writeFileSync(promptFile, [
        rolePrompt(trade),
        `## Refine 落层重构任务（目标层级：${item.layer}）\n标题：${item.title}\n\n${item.task}`,
        decisionNote ? `交互者补充要求：\n${decisionNote}` : '',
        repair ? `## 修复要求\n${repair.reason}\n保留已采纳的提纯改动，归档目录由流程管理。\n${repair.syncInstruction || ''}` : '',
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
      requireValue(delivered !== currentHead, `Refine 重构工单「${item.title}」未产生新提交（${delivered}），保留原归档未消费`);
      requireValue(isAncestor(root, currentHead, delivered), `Refine 重构工单「${item.title}」返回的提交（${delivered}）不是前序基线（${currentHead}）的严格后代，拒绝丢弃前序改动并保留原归档未消费`);
      git(root, 'checkout', '-B', refineBranch, delivered);
      currentHead = delivered;
    }
  }

  if (consume) {
    applyProseRefinements(root, diagnosis);
    consumeBackup(root, archive);
    git(root, 'add', '-A', '.dickda');
    requireValue(Boolean(git(root, 'status', '--porcelain', '--', '.dickda')), 'Refine 消费归档后未检测到 .dickda 变更');
    git(root, 'commit', '-m', `chore(dickda): refine ${archive} (${diagnosis.layers.join(',')})`);
    currentHead = git(root, 'rev-parse', 'HEAD');
  } else {
    requireValue(!existsSync(inside(root, archive)), '修复提交恢复了已消费的归档');
  }

  const verifyOutcome = runCodeVerifiers(root);
  requireValue(verifyOutcome.passed, `Refine 后的 L2/L3 验证未通过，拒绝持久化并保留原分支归档：\n${verifyOutcome.summary}`);
  return { head: currentHead, verifySummary: verifyOutcome.summary };
}

function rmIfExists(file) {
  if (existsSync(file)) writeFileSync(file, '');
}

function refineSummary(state) {
  const verdict = reviewVerdict(state.head, state.review);
  const kept = Object.entries(state.kept ?? {});
  requireValue(verdict.route === 'pr' || (verdict.route === 'changes' && state.kept?.[state.head]), verdict.reason);
  return [
    `## dickda模式 · 五层提纯 · ${state.archive}`,
    `落点层级：${state.choice === 'prose' ? 'L4' : state.diagnosis.layers.join('、')}\n\n${state.diagnosis.summary}`,
    `### 验证结果（${state.head}）\n${state.verifySummary}\n${checkRunsText(state.checks, state.head)}`,
    `### 独立审查 · ${state.review.decision}（${state.reviewer}）\n${state.review.line || ''}\n${state.review.report || ''}`,
    kept.length ? `### 交互者不采纳审查意见的依据，交用户最终裁决\n${kept.map(([head, reason]) => `- ${head}（REQUEST_CHANGES）：${reason}`).join('\n')}` : '',
  ].filter(Boolean).join('\n\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const env = process.env;
    const action = process.argv[2];
    const stateFile = join(env.CODA_ARTIFACTS, 'refine.json');
    const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : null;
    const saveState = next => save(stateFile, next);
    const settings = effectiveSettings(env);

    switch (action) {
      case 'collect': {
        if (state) {
          appendGithubOutput({ group: state.group, hasArchive: state.hasArchive, archive: state.archive ?? '' });
          break;
        }
        const root = repo();
        const repoInfo = JSON.parse(privateGh('repo', 'view', '--json', 'nameWithOwner,defaultBranchRef'));
        const defaultBranch = repoInfo.defaultBranchRef.name;
        const base = (env.BASE || '').trim() || defaultBranch;
        requireValue(base === defaultBranch, `仅允许以仓库默认分支 ${defaultBranch} 作为目标分支，当前指定的是 ${base}`);
        const remote = `https://github.com/${repoInfo.nameWithOwner}.git`;
        const baseCommit = fetchHead(root, remote, base);

        let startHead = (env.RUN_COMMIT || '').trim() || baseCommit;
        if (env.BRANCH && env.BRANCH.trim() && env.BRANCH.trim() !== base) {
          const b = env.BRANCH.trim();
          const hasLocal = spawnSync('git', ['-C', root, 'rev-parse', '--verify', `refs/heads/${b}^{commit}`]).status === 0;
          if (hasLocal) {
            startHead = git(root, 'rev-parse', '--verify', `refs/heads/${b}^{commit}`);
          } else {
            startHead = fetchHead(root, remote, b);
          }
        }
        git(root, 'checkout', '--detach', '--force', '--quiet', startHead);

        const ctx = buildRefineContext(root);
        const refineBranch = `dickda/refine-${env.GITHUB_RUN_ID}`;
        if (ctx.hasArchive) {
          remoteGit(root, 'push', '--quiet', '--no-follow-tags', remote, `${startHead}:refs/heads/${refineBranch}`);
        }
        const initial = {
          remote,
          base,
          baseCommit,
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
        const head = fetchHead(root, state.remote, state.refineBranch);
        git(root, 'checkout', '--detach', '--force', '--quiet', head);

        const promptFile = join(env.RUNNER_TEMP, 'refine-thinker.md');
        const archiveText = (state.files ?? []).map(f => `### ${f.name}\n\n${f.body}`).join('\n\n');
        const prompt = [
          rolePrompt('thinker'),
          `## Refine 归档复盘输入（归档目录：${state.archive}）\n${archiveText}`,
          `## 当前项目五层健康度\n\`\`\`json\n${JSON.stringify(state.health, null, 2)}\n\`\`\``,
          'learningUpdates 中的字符串写入 Learning_General.md。也可用 {"file":"Learning_Team.md","text":"经验条文"} 指定 Learning_*.md 文档。名称部分由 1–80 个英文字母、数字、下划线或连字符组成，以字母或数字开头。knowledgeUpdates 每项用 {"path":"knowledge/<name>.md","content":"完整正文"} 更新知识文档。',
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

      case 'execute':
      case 'repair': {
        const root = repo();
        const attempts = state.repairAttempts || 0;
        const repairing = action === 'repair';
        const reason = state.failure || `提纯执行中断，请查看 coda://workflow-runs/${env.GITHUB_RUN_ID} 中的执行日志。`;
        try {
          let repair;
          let baseCommit = state.baseCommit;
          if (repairing) {
            requireValue(attempts < settings.escalationThreshold + 1, `自动修复已达 ${attempts} 次`);
            state.repairAttempts = attempts + 1;
            saveState(state);
            repair = { reason, attempts };
            if (state.syncBase) {
              baseCommit = fetchHead(root, state.remote, state.base);
              repair.syncInstruction = `执行 git fetch ${state.remote} refs/heads/${state.base}，将默认分支提交 ${baseCommit} 合入提纯分支并解决冲突。`;
            }
          }
          const startHead = fetchHead(root, state.remote, state.refineBranch);
          requireValue(isAncestor(root, state.head, startHead), '提纯分支历史已改变，请核对并恢复前序提交');
          const executed = executeRefinePlan(root, { ...state, startHead, settings, repair });
          if (state.syncBase) requireValue(isAncestor(root, baseCommit, executed.head), `修复提交尚未合入默认分支提交 ${baseCommit}`);
          remoteGit(root, 'push', '--quiet', '--no-follow-tags', state.remote, `${executed.head}:refs/heads/${state.refineBranch}`);
          saveState({ ...state, ...executed, baseCommit, failure: '', syncBase: false });
          appendGithubOutput({ head: executed.head });
        } catch (error) {
          saveState({ ...state, failure: [repairing ? reason : '', error.message].filter(Boolean).join('\n') });
          throw error;
        }
        break;
      }

      case 'failed': {
        const failure = `${env.STEP}未通过（提交 ${state.head}，运行 coda://workflow-runs/${env.GITHUB_RUN_ID}）`;
        saveState({ ...state, failure: [failure, env.LINES].filter(Boolean).join('\n') });
        break;
      }

      case 'repair-status': {
        appendGithubOutput({ reason: state.failure, head: state.head });
        break;
      }

      case 'continue-repair': {
        saveState({ ...state, failure: `${state.failure}\n交互者指示：${env.NOTE}`, repairAttempts: 0 });
        break;
      }

      case 'prepare-review': {
        const checks = { head: state.head, runs: JSON.parse(env.RUNS || '[]') };
        const hard = state.choice === 'refactor' && state.diagnosis.actions.some(job => job.difficulty === 'hard');
        const reviewer = resolveEngineer('verifier', { difficulty: hard ? 'hard' : 'normal', rejections: state.repairAttempts }, settings);
        saveState({ ...state, checks, reviewer: reviewer.summary });
        appendGithubOutput({
          ...reviewRange(state),
          head: state.head,
          tier: reviewer.tier,
          task: `消费归档 ${state.archive}，交互者选择 ${state.choice}。\n${JSON.stringify(state.diagnosis)}\n${state.decisionNote}`,
          evidence: `${state.verifySummary}\n${checkRunsText(checks, state.head)}`,
        });
        break;
      }

      case 'reviewed': {
        let review;
        try { review = JSON.parse(env.REVIEW || 'null'); } catch { review = null; }
        const verdict = reviewVerdict(state.head, review);
        const kept = { ...state.kept };
        delete kept[state.head];
        if (verdict.route === 'retry') {
          saveState({ ...state, review: null, kept });
        } else {
          const openReviewFindings = openMusts(review, jsonList(env.PREVIOUS) ?? []);
          saveState({ ...state, review, lastReviewedHead: review.head, openReviewFindings, kept });
        }
        appendGithubOutput(verdict);
        break;
      }

      case 'review-decision': {
        const { choice, note } = JSON.parse(env.DECISION);
        const verdict = reviewVerdict(state.head, state.review);
        requireValue(verdict.route === 'changes', '当前提交没有待裁决的审查意见');
        if (choice === 'kept') {
          requireValue(note?.trim(), '不采纳审查意见须写明客观依据');
          saveState({ ...state, kept: { ...state.kept, [state.head]: note.trim() } });
        } else {
          requireValue(choice === 'repair', '请选择修复或记录不采纳依据');
          const issues = state.openReviewFindings.map(f => `- ${f.title}（${f.location}）：${f.detail}`);
          saveState({ ...state, failure: [verdict.reason, ...issues, note].filter(Boolean).join('\n') });
        }
        appendGithubOutput({ route: choice });
        break;
      }

      case 'deliver': {
        const bodyFile = join(env.CODA_ARTIFACTS, 'refine-pr.md');
        const summary = refineSummary(state);
        writeFileSync(bodyFile, summary);
        let pr = state.pr || JSON.parse(privateGh('pr', 'list', '--repo', state.remote, '--head', state.refineBranch, '--base', state.base, '--state', 'open', '--json', 'url'))[0]?.url;
        if (pr) privateGh('pr', 'edit', pr, '--body-file', bodyFile);
        else pr = privateGh('pr', 'create', '--repo', state.remote, '--base', state.base, '--head', state.refineBranch,
          '--title', `refactor(dickda): refine ${state.archive}`, '--body-file', bodyFile);
        saveState({ ...state, pr });
        appendGithubOutput({ commit: state.head, pr, summary });
        break;
      }

      case 'approval-check': {
        checkApprovalPr(state);
        appendGithubOutput({ summary: refineSummary(state) });
        break;
      }

      case 'merge': {
        const result = mergeApprovedPr(state, settings.mergeMethod);
        if (result.route === 'conflict') {
          saveState({ ...state, syncBase: true, failure: `PR ${state.pr} 与默认分支 ${state.base} 有合并冲突，请同步并解冲突后重验。` });
        }
        appendGithubOutput(result);
        break;
      }

      case 'stopped': {
        const reason = env.REASON || '暂不合并，保留原归档。';
        saveState({ ...state, stopReason: reason });
        appendGithubOutput({ reason, branch: state.refineBranch, pr: state.pr || '' });
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
