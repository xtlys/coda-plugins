import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { agentFailure, callCodaAgent, callDeliveryAgent } from './agent.mjs';
import { checkApprovalPr, mergeApprovedPr, privateGh } from './approval.mjs';
import { CONSUMED_FILE, archiveRoot, backups, branchChanges, consumeBackup, consumedArchives, consumptionRecord, layerHealth, pruneConsumedArchives, walkMarkdown } from './assets.mjs';
import { checkRunsText, jsonList, openMusts, reviewRange, reviewVerdict } from './review.mjs';
import { TRADES, agentArgs, effectiveSettings, loadSettings, resolveEngineer, rolePrompt } from './roles.mjs';
import { appendGithubOutput, atomic, git, managed, projectGroup, remoteGit, repo, requireValue, save } from './store.mjs';
import { extractJsonBlock, runCodeVerifiers } from './verify.mjs';

function fetchHead(root, remote, branch) {
  remoteGit(root, 'fetch', '--quiet', remote, `refs/heads/${branch}`);
  return git(root, 'rev-parse', 'FETCH_HEAD');
}

function isAncestor(root, ancestor, head) {
  return spawnSync('git', ['-C', root, 'merge-base', '--is-ancestor', ancestor, head]).status === 0;
}

export function buildRefineContext(root, consumed) {
  const archive = backups(root, 1, consumed)[0] ?? null;
  const files = archive ? walkMarkdown(root, archive).map(({ path, body }) => ({
    name: path.slice(archive.length + 1),
    body,
  })) : [];
  return { hasArchive: Boolean(archive), archive, files, health: layerHealth(root, consumed) };
}

function collectRefineContext(root, remote, base, branch) {
  const baseCommit = fetchHead(root, remote, base);
  let startHead = baseCommit;
  const baseConsumed = consumedArchives(root, baseCommit);
  let consumed = new Set(baseConsumed);
  if (branch && branch !== base) {
    const local = spawnSync('git', ['-C', root, 'rev-parse', '--verify', `refs/heads/${branch}^{commit}`], { encoding: 'utf8' });
    const branchHead = local.status === 0 ? local.stdout.trim() : fetchHead(root, remote, branch);
    const ancestor = git(root, 'merge-base', branchHead, baseCommit);
    if (ancestor !== branchHead) {
      startHead = branchHead;
      if (ancestor !== baseCommit) {
        const directories = commit => new Set(git(root, 'ls-tree', '-dz', '--name-only', commit, '--', '.dickda/learning/').split('\0'));
        consumed = consumed.union(directories(ancestor).difference(directories(baseCommit)));
      }
    }
  }
  git(root, 'checkout', '--detach', '--force', '--quiet', startHead);
  return { baseCommit, baseConsumed, startHead, ...buildRefineContext(root, consumed) };
}

const hasText = value => typeof value === 'string' && value.trim().length > 0;
const validLearningFilename = name => typeof name === 'string' && /^Learning_[A-Za-z0-9][A-Za-z0-9_-]{0,79}\.md$/.test(name);

function validKnowledgeUpdate(note) {
  const path = note?.path;
  return typeof path === 'string' && path.startsWith('knowledge/') && path.endsWith('.md')
    && !/[\\\0]/.test(path) && path.split('/').every(part => part && part !== '.' && part !== '..') && hasText(note.content);
}

export function normalizeDiagnosis(raw) {
  requireValue(raw && typeof raw === 'object' && !Array.isArray(raw), 'Refine 诊断须输出 JSON 对象');
  const { summary, layers, actions = [], obsoleteProse = [], learningUpdates = [], knowledgeUpdates = [] } = raw;
  requireValue(hasText(summary), 'Refine 诊断须包含非空 summary');
  requireValue(Array.isArray(layers) && layers.length && layers.every(l => ['L1', 'L2', 'L3', 'L4'].includes(l)), 'Refine 诊断的 layers 须指定 L1–L4 落点');
  requireValue(raw.needsRefactor === undefined || typeof raw.needsRefactor === 'boolean', 'needsRefactor 须为布尔值');
  const needsRefactor = raw.needsRefactor === true || layers.some(l => l !== 'L4');
  requireValue(Array.isArray(actions) && (!needsRefactor || actions.length) && actions.every(item =>
    layers.includes(item?.layer) && TRADES.includes(item.trade) && hasText(item.title) && hasText(item.task)
      && (item.difficulty === undefined || ['normal', 'hard'].includes(item.difficulty))), 'Refine 诊断的 actions 须提供与落层对应的有效Work Order');
  requireValue(Array.isArray(obsoleteProse) && obsoleteProse.every(hasText), 'obsoleteProse 须列出非空旧条文');
  requireValue(Array.isArray(learningUpdates) && learningUpdates.every(note => hasText(note)
    || (hasText(note?.text) && (note.file === undefined || validLearningFilename(note.file)))), 'learningUpdates 须包含有效的经验文档和非空条文');
  requireValue(Array.isArray(knowledgeUpdates) && knowledgeUpdates.every(validKnowledgeUpdate), '知识更新须包含 knowledge/ 下的 Markdown 路径和非空正文');
  requireValue(actions.length || obsoleteProse.length || learningUpdates.length || knowledgeUpdates.length, 'Refine 诊断没有可落地的Work Order或 L4 条文');
  return { needsRefactor, layers, summary: summary.trim(), actions, obsoleteProse, learningUpdates, knowledgeUpdates };
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
    requireValue(validLearningFilename(file), `无效的经验文档：${file}`);
    const target = managed(root, `learning/${file}`);
    const content = edits.get(target) ?? (existsSync(target) ? readFileSync(target, 'utf8') : '');
    const bullet = `- ${text.trim()}`;
    const recorded = new RegExp(`^${RegExp.escape(bullet)}(?: \\[\\d+\\])?[ \\t]*$`, 'm');
    if (!recorded.test(content)) edits.set(target, `${content}${content && !content.endsWith('\n') ? '\n' : ''}${bullet} [1]\n`);
  }
  if (Array.isArray(diagnosis.knowledgeUpdates)) {
    for (const note of diagnosis.knowledgeUpdates) {
      requireValue(validKnowledgeUpdate(note), '知识更新须包含 knowledge/ 下的 Markdown 路径和非空正文');
      edits.set(managed(root, note.path), note.content);
    }
  }
  for (const [file, content] of edits) atomic(file, content);
}

function checkRefineScope(root, startHead, tree, { allConsumed, choice, mergedUpstream }) {
  let substantive = false;
  for (const [path, { before, after, upstream }] of branchChanges(root, startHead, tree, { mergedUpstream })) {
    if (path === CONSUMED_FILE) continue;
    if (allConsumed.has(archiveRoot(path))) {
      requireValue(before === after || after.startsWith('000000 '), `已消费的归档仅允许删除：${path}`);
      continue;
    }
    const prose = (path.startsWith('.dickda/knowledge/') && path.endsWith('.md')) || /^\.dickda\/learning\/Learning_[^/]*\.md$/.test(path);
    const [oldMode, oldId] = before.split(' ');
    const [mode, id] = after.split(' ');
    const regularFile = mode === '100644' || mode === '100755';
    if (choice === 'prose') {
      requireValue(prose && (regularFile || mode === '000000'), `仅更新 L4 的Refine提交越界：${path}`);
      requireValue(before !== after, `Refine提交丢弃了Default Branch的上游变更：${path}`);
    }
    if (before === after || after === upstream) continue;
    if (prose) {
      if (regularFile && id !== oldId && id !== upstream?.split(' ')[1]
        && (oldMode !== '000000' || Number(git(root, 'cat-file', '-s', id)) > 0)) substantive = true;
    } else if (choice === 'refactor' && (!path.startsWith('.dickda/') || path.startsWith('.dickda/lints/') || path.startsWith('.dickda/verifiers/'))) {
      substantive = true;
    }
  }
  requireValue(substantive, 'Refine没有产生实质文件变更，保留原归档');
}

// Chain refactor engineer commits sequentially, then commit L4 prose updates + archive consumption,
// and verify via L2/L3 code verifiers BEFORE anything is pushed or reported complete.
export function executeRefinePlan(root, {
  startHead,
  head = startHead,
  baseConsumed = [],
  mergedUpstream,
  archive,
  choice,
  decisionNote = '',
  diagnosis,
  repair,
  settings = loadSettings(),
  runner,
  tempDir = process.env.RUNNER_TEMP || join(root, '.dickda'),
}) {
  git(root, 'checkout', '--detach', head);
  let currentHead = head;

  // A failed initial execution has published no candidate. Replay its selected actions and consume the archive once.
  const consume = !repair || Boolean(git(root, 'ls-tree', head, '--', archive));
  let jobs = consume && choice === 'refactor' ? diagnosis.actions ?? [] : [];
  if (repair && !jobs.length) {
    const owner = choice === 'refactor' ? diagnosis.actions?.at(-1) : null;
    jobs = [{ trade: owner?.trade || 'builder', difficulty: owner?.difficulty, layer: diagnosis.layers.join('、'), title: '修复Refine提交', task: diagnosis.summary }];
  }
  if (jobs.length) {
    mkdirSync(tempDir, { recursive: true });
    for (const [idx, item] of jobs.entries()) {
      const trade = item.trade;
      const resolved = resolveEngineer(trade, { difficulty: item.difficulty === 'hard' ? 'hard' : 'normal', rejections: repair?.attempts }, settings);
      const promptFile = join(tempDir, `refine-exec-${idx}.tmp`);
      writeFileSync(promptFile, [
        rolePrompt(trade),
        `## Refine 落层重构任务（目标层级：${item.layer}）\n标题：${item.title}\n\n${item.task}`,
        decisionNote ? `Interactor补充要求：\n${decisionNote}` : '',
        repair ? `## 修复要求\n${repair.reason}\n保留已采纳的Refine改动，目标归档 ${archive} 由流程删除。\n${repair.syncInstruction || ''}` : '',
        repair && choice === 'prose' ? `本轮可编辑 .dickda/knowledge/ 下含子目录的 Markdown（.md）文档、.dickda/learning/Learning_*.md 和消费记录 ${CONSUMED_FILE}。同步Default Branch时须原样保留其他路径的上游变更。` : '',
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
      const call = callDeliveryAgent(args, { cwd: root, baseHead: currentHead, promptFile, runner });
      rmIfExists(promptFile);
      const detail = agentFailure(call);
      requireValue(call.status === 0, `Refine 重构Work Order「${item.title}」执行失败，保留原归档未消费\n${detail}`);
      requireValue(call.head, `Refine 重构Work Order「${item.title}」未返回有效交付提交 SHA，保留原归档未消费\n${detail}`);
      const delivered = git(root, 'rev-parse', '--verify', `${call.head}^{commit}`);
      requireValue(delivered !== currentHead, `Refine 重构Work Order「${item.title}」未产生新提交（${delivered}），保留原归档未消费\n${detail}`);
      requireValue(isAncestor(root, currentHead, delivered), `Refine 重构Work Order「${item.title}」返回的提交（${delivered}）不是前序基线（${currentHead}）的严格后代，拒绝丢弃前序改动并保留原归档未消费\n${detail}`);
      git(root, 'checkout', '--detach', delivered);
      currentHead = delivered;
    }
  }

  if (mergedUpstream) requireValue(isAncestor(root, mergedUpstream, currentHead), `修复提交尚未合入Default Branch提交 ${mergedUpstream}`);
  const revisions = new Set([startHead, head, mergedUpstream].filter(Boolean));
  const history = [...revisions].flatMap(commit => consumedArchives(root, commit));
  const allConsumed = new Set([...baseConsumed, ...history, archive]);
  const record = consumptionRecord(allConsumed);
  const scope = { allConsumed, choice, mergedUpstream };
  if (consume) {
    applyProseRefinements(root, diagnosis);
    git(root, 'add', '-A', '.dickda');
  }
  checkRefineScope(root, startHead, consume ? git(root, 'write-tree') : currentHead, scope);
  if (consume) {
    consumeBackup(root, archive, record);
    git(root, 'add', '-A', '--', archive, CONSUMED_FILE);
  }
  const removed = pruneConsumedArchives(root, allConsumed);
  if (removed.length) git(root, 'rm', '-r', '--cached', '--ignore-unmatch', '--', ...removed);
  if (consume || (removed.length && git(root, 'diff', '--cached', '--name-only'))) {
    git(root, 'commit', '-m', `chore(dickda): refine ${archive} (${diagnosis.layers.join(',')})`);
    currentHead = git(root, 'rev-parse', 'HEAD');
    checkRefineScope(root, startHead, currentHead, scope);
  }
  const remaining = git(root, 'ls-tree', '-z', '--name-only', currentHead, '--', '.dickda/learning/').split('\0').filter(path => allConsumed.has(path));
  requireValue(!remaining.length, `Refine提交仍包含已消费的归档：${remaining.join('、')}`);
  requireValue(consumedArchives(root, currentHead).join('\n') === record, `Refine提交须保留历史消费记录并登记当前归档：${CONSUMED_FILE}`);

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
    `## dickda Mode · 五层Refine · ${state.archive}`,
    `落点层级：${state.choice === 'prose' ? 'L4' : state.diagnosis.layers.join('、')}\n\n${state.diagnosis.summary}`,
    `### 验证结果（${state.head}）\n${state.verifySummary}\n${checkRunsText(state.checks, state.head)}`,
    `### Independent Code Review · ${state.review.decision}（${state.reviewer}）\n${state.review.line || ''}\n${state.review.report || ''}`,
    kept.length ? `### Interactor不采纳审查意见的依据，交用户最终裁决\n${kept.map(([head, reason]) => `- ${head}（REQUEST_CHANGES）：${reason}`).join('\n')}` : '',
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
      case 'prepare': {
        const repoInfo = JSON.parse(privateGh('repo', 'view', '--json', 'nameWithOwner,defaultBranchRef'));
        const defaultBranch = repoInfo.defaultBranchRef.name;
        const base = (env.BASE || '').trim() || defaultBranch;
        requireValue(base === defaultBranch, `仅允许以仓库Default Branch ${defaultBranch} 作为目标分支，当前指定的是 ${base}`);
        const remote = `https://github.com/${repoInfo.nameWithOwner}.git`;
        const group = projectGroup(repo(), remote);
        if (!state) saveState({ remote, base, group });
        appendGithubOutput({ group });
        break;
      }

      case 'collect': {
        if (state.hasArchive !== undefined) {
          appendGithubOutput({ hasArchive: state.hasArchive, archive: state.archive ?? '' });
          break;
        }
        const root = repo();
        const ctx = collectRefineContext(root, state.remote, state.base, env.BRANCH?.trim());
        const refineBranch = `dickda/refine-${env.GITHUB_RUN_ID}`;
        if (ctx.hasArchive) {
          remoteGit(root, 'push', '--quiet', '--no-follow-tags', state.remote, `${ctx.startHead}:refs/heads/${refineBranch}`);
        }
        saveState({ ...state, ...ctx, head: ctx.startHead, refineBranch });
        appendGithubOutput({ hasArchive: ctx.hasArchive, archive: ctx.archive ?? '' });
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
          'learningUpdates 中的字符串写入 Learning_General.md。也可用 {"file":"Learning_Team.md","text":"经验条文"} 指定 Learning_*.md 文档。名称部分由 1–80 个英文字母、数字、下划线或连字符组成，以字母或数字开头。knowledgeUpdates 每项用 {"path":"knowledge/<name>.md","content":"完整正文"} 更新Knowledge Base。',
          '诊断须给出非空 summary 和 layers。建议重构或选择 L1–L3 时须列出对应的Work Order。仅更新 L4 时请给出可实际应用的旧条文、经验或知识更新。',
          `## 输出要求\n评估该归档暴露的痛点是否需要结构性演进或重构，并确定应落实到哪几个层次（L1 架构/接口重构、L2 .dickda/lints 可执行规则、L3 .dickda/verifiers 结果验证器、L4 知识/经验文档更新与旧口头规则瘦身）。在末尾输出 \`\`\`json 块：\n\`\`\`json\n{\n  "needsRefactor": true,\n  "layers": ["L2", "L4"],\n  "summary": "诊断结论摘要",\n  "actions": [{"layer": "L2", "trade": "architect", "difficulty": "normal", "title": "...", "task": "..."}],\n  "obsoleteProse": [],\n  "learningUpdates": [],\n  "knowledgeUpdates": []\n}\n\`\`\``,
        ].join('\n\n');
        writeFileSync(promptFile, prompt);

        const res = callCodaAgent([
          '--commit', head,
          '--title', `Thinker Refine 诊断：${state.archive}`,
          ...agentArgs(settings.thinker),
          '--json',
          '--prompt-file', promptFile,
        ], root);
        requireValue(res.status === 0 && res.parsed, `Thinker Refine 诊断失败：${agentFailure(res)}`);
        const reply = res.parsed;
        const diagnosis = normalizeDiagnosis(extractJsonBlock(reply.answer));
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
        const reason = state.failure || `Refine执行中断，请查看 coda://workflow-runs/${env.GITHUB_RUN_ID} 中的执行日志。`;
        try {
          let repair;
          let mergedUpstream = state.mergedUpstream;
          if (repairing) {
            requireValue(attempts < settings.escalationThreshold + 1, `自动修复已达 ${attempts} 次`);
            state.repairAttempts = attempts + 1;
            saveState(state);
            repair = { reason, attempts };
            if (state.syncBase) {
              mergedUpstream = fetchHead(root, state.remote, state.base);
              repair.syncInstruction = `执行 git fetch ${state.remote} refs/heads/${state.base}，将Default Branch提交 ${mergedUpstream} 合入Refine分支并解决冲突。合并 ${CONSUMED_FILE} 时须保留双方与当前批次的记录，逐行排序去重。`;
            }
          }
          const head = fetchHead(root, state.remote, state.refineBranch);
          requireValue(isAncestor(root, state.head, head), 'Refine分支历史已改变，请核对并恢复前序提交');
          const executed = executeRefinePlan(root, { ...state, head, mergedUpstream, settings, repair });
          remoteGit(root, 'push', '--quiet', '--no-follow-tags', state.remote, `${executed.head}:refs/heads/${state.refineBranch}`);
          saveState({ ...state, ...executed, baseCommit: mergedUpstream ?? state.baseCommit, mergedUpstream, failure: '', syncBase: false });
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
        saveState({ ...state, failure: `${state.failure}\nInteractor指示：${env.NOTE}`, repairAttempts: 0 });
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
          task: `Archive Consumption ${state.archive}，Interactor选择 ${state.choice}。\n${JSON.stringify(state.diagnosis)}\n${state.decisionNote}`,
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
          saveState({ ...state, syncBase: true, failure: `PR ${state.pr} 与Default Branch ${state.base} 有合并冲突，请同步并解冲突后重验。` });
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
