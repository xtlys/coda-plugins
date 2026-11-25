import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkApprovalPr, mergeApprovedPr, privateGh } from './approval.mjs';
import { checkSpecLock, remember, runLints } from './assets.mjs';
import { enabledGuidelinesDigest } from './prompts.mjs';
import { checkRunsText, jsonList, openMusts, requestedChanges, reviewRange, reviewVerdict } from './review.mjs';
import { TRADES, agentArgs, effectiveSettings, formatAgent, loadSettings, resolveEngineer, rolePrompt } from './roles.mjs';
import { DEFAULT_PLAN, appendGithubOutput, atomic, init, managed, projectGroup, remoteGit, repo, requireValue } from './store.mjs';
import { extractJsonBlock } from './verify.mjs';

export { effectiveSettings };

function runCmd(bin, args) {
  return execFileSync(bin, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  }).trim();
}

const git = (...args) => runCmd('git', args);
const gh = (...args) => runCmd('gh', args);

function fetchHead(remote, branch) {
  remoteGit('.', 'fetch', '--quiet', remote, `refs/heads/${branch}`);
  return git('rev-parse', 'FETCH_HEAD');
}

function retainWorkerHead(remote, id, head) {
  const ref = `refs/heads/dickda/prev-${process.env.GITHUB_RUN_ID}-${id}`;
  remoteGit('.', 'push', '--quiet', '--force', '--no-follow-tags', remote, `${head}:${ref}`);
  return ref;
}

function releasePreviousRefs(ledger, all = false) {
  const entries = Object.values(ledger).filter(item => item.lastRejectedRef && (all || ['landed', 'replaced'].includes(item.status)));
  const refs = [...new Set(entries.map(item => item.lastRejectedRef))];
  for (const item of entries) delete item.lastRejectedRef;
  return refs;
}

function deleteRefs(remote, refs) {
  if (refs.length) remoteGit('.', 'push', '--quiet', '--no-follow-tags', remote, ...refs.map(ref => `:${ref}`));
}

export function enrichDispatchBatch(rawJobs, ledger = {}, settings = loadSettings()) {
  requireValue(Array.isArray(rawJobs) && rawJobs.length >= 1 && rawJobs.length <= 12, 'dispatch 批次须包含 1–12 个并发工单');
  const seen = new Set();
  return rawJobs.map((job, idx) => {
    const jobId = String(job.id || `job-${idx + 1}`).trim();
    requireValue(/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(jobId), `工单 ID 不合法：${jobId}`);
    const current = Object.hasOwn(ledger, jobId) ? ledger[jobId] : null;
    const replaces = job.replaces ?? (current?.status === 'rejected' ? current.replaces : null);
    if (replaces) {
      requireValue(ledger[replaces]?.status === 'rejected' && (!current || current.replaces === replaces), `工单 ${jobId} 的 replaces 须指向原被打回的工单：${replaces}`);
      requireValue(!seen.has(replaces), `同一批次不能重复派发被替代工单：${replaces}`);
      seen.add(replaces);
    }
    requireValue(!seen.has(jobId), `同一并发批次内工单 ID 重复：${jobId}`);
    seen.add(jobId);
    requireValue(TRADES.includes(job.trade), `工单 ${jobId} 的工种须为 architect、builder 或 verifier`);
    requireValue(typeof job.title === 'string' && job.title.trim(), `工单 ${jobId} 缺少 title`);
    requireValue(typeof job.task === 'string' && job.task.trim(), `工单 ${jobId} 缺少 task`);

    const prev = current ?? (replaces ? ledger[replaces] : {});
    if (prev.status === 'rejected') {
      const previousId = current ? jobId : replaces;
      const retry = Object.values(ledger).find(entry => entry.status === 'rejected' && entry.replaces === previousId);
      if (retry) throw new Error(`工单 ${previousId} 的最新打回记录在 ${retry.id}，请复用该 ID 或在 replaces 中指向它`);
    }
    requireValue(prev.status !== 'rejected' || (prev.trade === 'verifier') === (job.trade === 'verifier'), `工单 ${jobId} 重试时不能在编码和验证工种间互换`);
    const difficulty = job.difficulty === 'hard' ? 'hard' : 'normal';
    const resolved = resolveEngineer(job.trade, {
      tier: job.tier,
      difficulty,
      rejections: prev.rejections ?? 0,
    }, settings);

    return {
      id: jobId,
      ...(replaces ? { replaces } : {}),
      trade: job.trade,
      difficulty,
      tier: resolved.tier,
      escalated: resolved.escalated,
      escalationReason: resolved.reason,
      rejections: prev.rejections ?? 0,
      title: job.title.trim(),
      task: job.task.trim(),
      lockSpec: job.trade === 'builder' ? job.lockSpec !== false : false,
      agent: resolved.agent,
      agentSummary: resolved.summary,
      previousHead: prev.lastRejectedHead ?? null,
      previousRef: prev.lastRejectedRef ?? null,
      previousFeedback: prev.lastFeedback ?? '',
    };
  });
}

export function evaluateVerifierAnswer(answerText = '') {
  const verdict = extractJsonBlock(answerText);
  if (!verdict || typeof verdict.passed !== 'boolean') {
    return {
      valid: false,
      passed: false,
      summary: '',
      findings: [],
      error: '验证工程师未输出含布尔值 passed 的结构化 JSON 结论',
    };
  }
  const findings = Array.isArray(verdict.findings) ? verdict.findings : [];
  const hasMust = findings.some(f => f?.level === 'must');
  const passed = verdict.passed === true && !hasMust;
  const summary = String(verdict.summary ?? '').trim();
  return {
    valid: true,
    passed,
    summary,
    findings,
    ...(passed ? {} : { error: summary || (hasMust ? '验证发现必须修（must）缺陷' : '验证结论为未通过（passed=false）') }),
  };
}

// Merge multiple parallel worker commits cleanly onto baseTip using git merge-tree --write-tree.
export function integrateWorkerResults(cwd, baseTip, workerResults, ledger = {}, settings = loadSettings()) {
  const order = { architect: 0, builder: 1, verifier: 2 };
  const sorted = [...workerResults].sort((a, b) => (order[a.trade] ?? 9) - (order[b.trade] ?? 9) || a.id.localeCompare(b.id));
  let tip = baseTip;
  const landed = [];
  const rejected = [];
  const findings = [];

  for (const w of sorted) {
    const entry = Object.hasOwn(ledger, w.id) ? ledger[w.id] : {
      id: w.id, trade: w.trade, title: w.title, rejections: w.rejections ?? 0,
      ...(w.replaces ? { replaces: w.replaces } : {}),
      ...(w.previousHead ? { lastRejectedHead: w.previousHead, lastRejectedRef: w.previousRef } : {}),
    };
    if (w.trade === 'verifier') {
      for (const f of w.findings ?? []) findings.push({ ...f, sourceJob: w.id, verifier: w.agentSummary });
      if (w.status === 'succeeded' && w.passed === true) {
        entry.status = 'verified';
        entry.tier = w.tier;
        entry.agentSummary = w.agentSummary;
        entry.lastAnswer = w.summary ?? '';
        entry.lastFeedback = '';
      } else {
        entry.rejections = (entry.rejections ?? 0) + 1;
        entry.status = 'rejected';
        entry.lastFeedback = w.error || w.summary || '验证工单未通过或结论缺失';
        const next = resolveEngineer('verifier', { difficulty: w.difficulty, rejections: entry.rejections }, settings);
        entry.nextTier = next.tier;
        rejected.push({ id: w.id, reason: entry.lastFeedback, rejections: entry.rejections, nextTier: next.tier });
      }
      ledger[w.id] = entry;
      continue;
    }

    if (w.status !== 'succeeded' || !w.head) {
      entry.rejections = (entry.rejections ?? 0) + 1;
      entry.status = 'rejected';
      if (w.retainedRef) {
        entry.lastRejectedHead = w.head;
        entry.lastRejectedRef = w.retainedRef;
      }
      entry.lastFeedback = w.error || '未产出有效提交';
      const next = resolveEngineer(w.trade, { difficulty: w.difficulty, rejections: entry.rejections }, settings);
      entry.nextTier = next.tier;
      ledger[w.id] = entry;
      rejected.push({ id: w.id, reason: entry.lastFeedback, rejections: entry.rejections, nextTier: next.tier });
      continue;
    }

    const isFastForward = tip === baseTip
      && spawnSync('git', ['-C', cwd, 'merge-base', '--is-ancestor', baseTip, w.head]).status === 0;
    if (isFastForward) {
      tip = w.head;
      entry.status = 'landed';
      entry.commit = tip;
      entry.tier = w.tier;
      entry.agentSummary = w.agentSummary;
      ledger[w.id] = entry;
      landed.push({ id: w.id, commit: tip, trade: w.trade, tier: w.tier });
      continue;
    }

    const merged = spawnSync('git', ['-C', cwd, 'merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', tip, w.head], {
      encoding: 'utf8',
    });
    if (merged.error) throw merged.error;
    if (merged.status === 0) {
      const tree = merged.stdout.split('\0')[0].trim();
      const msg = `Merge concurrent ${w.trade} job ${w.id}: ${w.title}`;
      const newCommit = execFileSync('git', ['-C', cwd, 'commit-tree', tree, '-p', tip, '-p', w.head, '-m', msg], {
        encoding: 'utf8',
      }).trim();
      tip = newCommit;
      entry.status = 'landed';
      entry.commit = tip;
      entry.tier = w.tier;
      entry.agentSummary = w.agentSummary;
      ledger[w.id] = entry;
      landed.push({ id: w.id, commit: tip, trade: w.trade, tier: w.tier });
    } else {
      const conflictFiles = merged.stdout.split('\0').slice(1).filter(Boolean);
      entry.rejections = (entry.rejections ?? 0) + 1;
      entry.status = 'rejected';
      entry.lastRejectedHead = w.head;
      entry.lastFeedback = `并发合入冲突（冲突文件：${conflictFiles.join('、') || '未知'}），请在最新需求分支上复用前序提交并解决冲突`;
      const next = resolveEngineer(w.trade, { difficulty: w.difficulty, rejections: entry.rejections }, settings);
      entry.nextTier = next.tier;
      ledger[w.id] = entry;
      rejected.push({ id: w.id, reason: entry.lastFeedback, rejections: entry.rejections, nextTier: next.tier });
    }
  }

  for (const { id } of landed) {
    let replaced = ledger[id].replaces;
    while (replaced && ledger[replaced]?.status === 'rejected') {
      const original = ledger[replaced];
      original.status = 'replaced';
      original.replacedBy = id;
      replaced = original.replaces;
    }
  }
  return { tip, changed: tip !== baseTip, landed, rejected, findings, ledger };
}

export function evaluateVerificationGate({ head, verifyCommit, verifyPassed, verifyReport = '', review = null }) {
  if (!verifyPassed || verifyCommit !== head) {
    const detail = verifyCommit && verifyCommit !== head
      ? `双轨验证提交（${verifyCommit}）与当前交付 HEAD（${head}）不一致，需重新验证。\n${verifyReport}`
      : verifyReport;
    const extraReview = review && review.head === head && review.decision === 'REQUEST_CHANGES'
      ? `\n\n### 独立代码审查（Sol）结论：REQUEST_CHANGES\n${review.line ?? ''}\n${review.report ?? ''}`
      : '';
    return {
      route: 'lead',
      reason: `### 双轨验证未通过\n${detail}${extraReview}`,
    };
  }

  const verdict = reviewVerdict(head, review);
  return verdict.route === 'changes' ? { ...verdict, route: 'lead' } : verdict;
}

function callCodaAgent(args, cwd = process.cwd()) {
  const res = spawnSync('coda-agent', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  if (res.error) throw res.error;
  let parsed = null;
  try { parsed = JSON.parse(res.stdout); } catch {}
  return { status: res.status ?? 1, stdout: res.stdout, parsed };
}

function dualReport(state) {
  const sections = [state.verifyReport];
  for (const [label, raw] of [['双轨发现', state.verifyFindings], ['实证证据', state.verifyEvidence]]) {
    if (!raw) continue;
    const items = jsonList(raw);
    const detail = items ? items.map(item => `- ${typeof item === 'string' ? item : JSON.stringify(item)}`).join('\n') : raw;
    sections.push(`**${label}**\n${detail || '无'}`);
  }
  return sections.filter(Boolean).join('\n\n');
}

const ignoredLines = items => items.map((item, index) =>
  `- ${[item.id, item.title].filter(Boolean).join(' ') || `审查意见 ${index + 1}`}：${item.reason}`
).join('\n');

export function buildPrSummary(state) {
  const landedLines = Object.values(state.ledger ?? {})
    .filter(item => item.status === 'landed')
    .map(item => `- [${item.trade}/${item.tier}] ${item.id} · ${item.title}（${item.agentSummary ?? ''}）`);
  const rebutted = requestedChanges(state, state.head) && state.rebuttedReviewHead === state.head;
  const review = state.review?.head === state.head
    ? `**Sol 原审查结论：${state.review.decision}**\n${state.review.line ?? ''}\n${state.review.report ?? ''}` : '';
  const dual = dualReport(state);

  return [
    rebutted ? `### 需用户最终裁决：主控建议在 Sol 要求修改的情况下交付\n${review}\n\n#### 主控逐条不采纳依据\n${ignoredLines(state.reviewRebuttals)}` : '',
    state.report || `需求：${state.title}`,
    `### 五层交付证据（提交 \`${state.head}\`）`,
    `#### 项目检查（L2）\n${checkRunsText(state.checks, state.head)}`,
    dual ? `#### 结果导向双轨验证（L3）\n${dual}` : '',
    review && !rebutted ? `#### 独立代码评审（Sol）\n${review}` : '',
    landedLines.length ? `#### 已合入工单\n${landedLines.join('\n')}` : '',
    state.ignoredFindings?.length ? `#### 主控裁定忽略的非阻塞项及依据\n${ignoredLines(state.ignoredFindings)}` : '',
    state.lastArchive ? `#### 调查归档\n已持久化至 \`${state.lastArchive}\`（待后续 \`dickda-refine\` 提纯）` : '',
    state.acceptedHead === state.head ? `#### 设备人工验收\n${state.acceptance ?? '已确认通过'}` : '',
  ].filter(Boolean).join('\n\n');
}

function parseBriefText(note = '', fallbackTitle = '') {
  const lines = String(note ?? '').trim().split(/\r?\n/);
  const first = lines[0]?.trim() ?? '';
  const rest = lines.slice(1).join('\n').trim();
  const title = fallbackTitle.trim() || first;
  const goal = rest || first;
  return { title, goal };
}

function existingTask(markdown) {
  const body = markdown.trim();
  if (!body || /^#\s+TODO TASK$/i.test(body)) return null;
  return parseBriefText(body.replace(/^#\s+/, ''));
}

// Bound each layer separately so a long L1 cannot hide the human decision in L5.
function planPreview(markdown) {
  const layers = [...markdown.matchAll(/^[ \t]*(?:#{1,6}[ \t]+[^\n]*?|(?:[-*+|]|\d+[.)、])?[ \t]*\*{0,2})L([1-5])\b.*$/gim)];
  const previews = new Map();
  for (const [index, match] of layers.entries()) {
    const section = markdown.slice(match.index, layers[index + 1]?.index).trim();
    const heading = match[0].trim();
    if (section === heading && (heading.startsWith('#') ? !/[:：]\s*\S/.test(heading) : !/L[1-5]\b.*[\p{L}\p{N}]/iu.test(heading))) continue;
    if (!previews.has(match[1])) previews.set(match[1], section.length > 700 ? `${section.slice(0, 699)}…` : section);
  }
  return previews.size === 5 ? [...previews.values()].join('\n\n') : '';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const env = process.env;
    const action = process.argv[2];
    const stateFile = join(env.CODA_ARTIFACTS, 'develop.json');
    const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : null;
    const saveState = next => atomic(stateFile, `${JSON.stringify(next, null, 2)}\n`);
    const settings = effectiveSettings(env);

    switch (action) {
      case 'lane': {
        if (state) {
          appendGithubOutput({
            group: state.group,
            reqBranch: state.reqBranch,
            base: state.base,
            baseCommit: state.baseCommit,
            needBrief: !state.goal,
          });
          break;
        }
        const root = repo();
        const deps = env.CODA_PLUGIN_DEPENDENCIES ? JSON.parse(env.CODA_PLUGIN_DEPENDENCIES) : {};
        if (deps.review) {
          requireValue(existsSync(join(deps.review, '.coda/capabilities/review-commit.bpmn')), '需要官方 review 插件提供 review-commit 能力');
        }
        const repoInfo = JSON.parse(gh('repo', 'view', '--json', 'nameWithOwner,defaultBranchRef'));
        const defaultBranch = repoInfo.defaultBranchRef.name;
        const base = (env.BASE || '').trim() || defaultBranch;
        const remote = `https://github.com/${repoInfo.nameWithOwner}.git`;
        const baseCommit = fetchHead(remote, base);

        let startCommit = baseCommit;
        const branch = env.BRANCH?.trim();
        if (branch) {
          const local = spawnSync('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`], { encoding: 'utf8' });
          if (local.status === 0) startCommit = local.stdout.trim();
          else if (branch !== base) startCommit = fetchHead(remote, branch);
        }
        const reqBranch = `dickda/req-${env.GITHUB_RUN_ID}`;
        remoteGit('.', 'push', '--quiet', '--force', '--no-follow-tags', remote, `${startCommit}:refs/heads/${reqBranch}`);

        let goal = (env.GOAL || '').trim();
        const briefProvided = Boolean(goal);
        let title = (env.TITLE || '').trim() || goal.split(/\r?\n/)[0].slice(0, 80);
        const todo = '.dickda/tasks/TODO_TASK.md';
        if (!goal && git('ls-tree', '--name-only', startCommit, '--', todo)) {
          const task = existingTask(git('show', `${startCommit}:${todo}`));
          if (task) {
            goal = task.goal;
            title ||= task.title;
          }
        }
        const group = projectGroup(root);
        const initial = {
          remote,
          defaultBranch,
          base,
          baseCommit,
          reqBranch,
          head: startCommit,
          group,
          title,
          goal,
          briefProvided,
          round: 0,
          leadSession: null,
          ledger: {},
          ignoredFindings: [],
          pendingFeedback: '',
          pr: '',
          acceptedHead: '',
          lastArchive: '',
        };
        saveState(initial);
        appendGithubOutput({
          group,
          reqBranch,
          base,
          baseCommit,
          needBrief: !goal,
        });
        break;
      }

      case 'brief': {
        const reply = JSON.parse(env.BRIEF || '{}');
        const { title, goal } = parseBriefText(reply.note, state.title);
        if (!title || !goal) {
          appendGithubOutput({ route: 'again', feedback: '请在备注第一行写需求标题，换行写清需求目标与验收标准。' });
          break;
        }
        saveState({ ...state, title, goal, briefProvided: true });
        appendGithubOutput({ route: 'ok', feedback: '' });
        break;
      }

      case 'seed': {
        const root = repo();
        let head = fetchHead(state.remote, state.reqBranch);
        git('checkout', '-B', state.reqBranch, head);
        init(root);
        const todo = managed(root, 'tasks/TODO_TASK.md');
        const plan = managed(root, 'tasks/PLAN_5L.md');
        const original = readFileSync(todo, 'utf8').trim().replaceAll('\r\n', '\n');
        const task = existingTask(original);
        const goal = state.goal.replaceAll('\r\n', '\n');
        const sameGoal = task && (goal === task.goal || goal === original);
        const goalChanged = state.briefProvided && !sameGoal;
        if (!task || goalChanged) atomic(todo, `# ${state.title}\n\n${state.goal}\n`);
        if (goalChanged) atomic(plan, DEFAULT_PLAN);
        const preview = planPreview(readFileSync(plan, 'utf8'));
        git('add', '.dickda');
        if (git('status', '--porcelain', '--', '.dickda')) {
          git('commit', '-m', `chore(dickda): initialize .dickda assets for ${state.title}`);
          head = git('rev-parse', 'HEAD');
          remoteGit('.', 'push', '--quiet', '--no-follow-tags', state.remote, `${head}:refs/heads/${state.reqBranch}`);
        }
        saveState({ ...state, head });
        appendGithubOutput({ head, hasPlan: Boolean(preview), preview });
        break;
      }

      case 'think': {
        const root = repo();
        const thinkBase = fetchHead(state.remote, state.reqBranch);
        git('checkout', '-B', state.reqBranch, thinkBase);
        const promptFile = join(env.RUNNER_TEMP, 'thinker.md');
        const prompt = [
          rolePrompt('thinker'),
          `## 当前项目已启用规范摘要\n${enabledGuidelinesDigest(root)}`,
          `## 本次需求原文（.dickda/tasks/TODO_TASK.md）\n${readFileSync(managed(root, 'tasks/TODO_TASK.md'), 'utf8')}`,
          state.planFeedback ? `## 交互者/用户修订意见\n${state.planFeedback}` : '',
          `请将完整的五层技术方案写入 \`.dickda/tasks/PLAN_5L.md\` 并提交到当前分支（不要推送或开 PR），最后简要汇报五层核心设计。`,
        ].filter(Boolean).join('\n\n');
        writeFileSync(promptFile, prompt);
        const call = callCodaAgent([
          '--commit', thinkBase,
          '--title', `思考者规划：${state.title}`,
          ...agentArgs(settings.thinker),
          '--json',
          '--prompt-file', promptFile,
        ], root);
        requireValue(call.status === 0 && call.parsed?.head, `思考者会话未成功产出五层方案提交（退出码 ${call.status}）`);
        const thoughtHead = git('rev-parse', '--verify', `${call.parsed.head}^{commit}`);
        const validDescendant = thoughtHead !== thinkBase
          && spawnSync('git', ['-C', root, 'merge-base', '--is-ancestor', thinkBase, thoughtHead]).status === 0;
        requireValue(validDescendant, `思考者返回的提交（${thoughtHead}）不是当前需求分支基线（${thinkBase}）的严格后代`);
        const preview = planPreview(git('show', `${thoughtHead}:.dickda/tasks/PLAN_5L.md`));
        requireValue(preview, '思考者提交的 PLAN_5L.md 须含 L1–L5 各层方案正文');
        remoteGit('.', 'push', '--quiet', '--no-follow-tags', state.remote, `${thoughtHead}:refs/heads/${state.reqBranch}`);
        saveState({ ...state, head: thoughtHead, planAnswer: call.parsed.answer ?? '', planFeedback: '' });
        appendGithubOutput({ head: thoughtHead, preview });
        break;
      }

      case 'plan-feedback': {
        const planFeedback = env.FEEDBACK?.trim();
        requireValue(planFeedback, '退回思考者时须填写方案修订意见');
        saveState({ ...state, planFeedback });
        break;
      }

      case 'lead-plan': {
        const root = repo();
        const fetchedHead = fetchHead(state.remote, state.reqBranch);
        git('checkout', '-B', state.reqBranch, fetchedHead);
        const round = (state.round ?? 0) + 1;
        const planBody = existsSync(managed(root, 'tasks/PLAN_5L.md')) ? readFileSync(managed(root, 'tasks/PLAN_5L.md'), 'utf8') : '';
        const ledgerSummary = Object.values(state.ledger ?? {}).map(item => [
          `- ${item.id} [${item.trade}] status=${item.status}, rejections=${item.rejections ?? 0}`,
          item.replaces && `replaces=${item.replaces}`, item.replacedBy && `replacedBy=${item.replacedBy}`,
          item.status === 'rejected' && item.nextTier === 'senior' && '下次派单自动升级 senior',
          item.status === 'rejected' && item.lastFeedback,
        ].filter(Boolean).join(' ')).join('\n') || '尚无工单记录。';

        const promptFile = join(env.RUNNER_TEMP, `lead-${round}.md`);
        const last = state.lastLeadHead;
        const sync = state.leadSession && [
          `## 续跑代码视图\n如需查阅最新代码或规约，先执行：\ngit fetch ${state.remote} ${state.reqBranch} && git checkout --detach ${fetchedHead}`,
          last ? `从 ${last} 到 ${fetchedHead} 的新增提交：\n${git('log', '--oneline', '--no-decorate', `${last}..${fetchedHead}`) || '无'}\n\ngit diff --stat：\n${git('diff', '--stat', last, fetchedHead) || '无变化'}` : '',
        ].filter(Boolean).join('\n\n');
        const initialContext = () => [rolePrompt('lead'), `## 需求原文\n${state.goal}`, `## 五层技术方案（PLAN_5L.md）\n${planBody}`].join('\n\n');
        const prompt = [
          sync || initialContext(),
          `## 第 ${round} 轮主控决策上下文`,
          `- 需求分支：\`${state.reqBranch}\`，当前 HEAD：\`${fetchedHead}\``,
          `- 自动升级阈值：常规工程师连续被打回 >= ${settings.escalationThreshold} 次自动升级高级工程师`,
          `- 可用工种级别：\n  - architect：常规 ${formatAgent(settings.architect.standard)} ｜ 高级 ${formatAgent(settings.architect.senior)}\n  - builder：常规 ${formatAgent(settings.builder.standard)} ｜ 高级 ${formatAgent(settings.builder.senior)}\n  - verifier：常规 ${formatAgent(settings.verifier.standard)} ｜ 高级 ${formatAgent(settings.verifier.senior)}`,
          `## 工单账本状态\n${ledgerSummary}`,
          state.pendingFeedback ? `## 最新待裁决反馈 / 检查与审查结果\n${state.pendingFeedback}` : '',
          '重试 status=rejected 的工单必须原样复用其 id，或用 replaces 指明原工单 id。verify 时，放弃的编码工单须在 ignoredFindings 中按工单 id 写明原因。对同一 HEAD 的 REQUEST_CHANGES，须对每条未采纳意见按编号或标题给出客观 reason。',
          `## 输出格式要求（严格遵守）\n请在回复末尾输出一个 \`\`\`json 代码块，action 取值之一：\n1. \`"dispatch"\`：并发派发 1–12 个无相互阻塞依赖的工单（可同时涵盖 architect / builder / verifier）：\n\`\`\`json\n{\n  "action": "dispatch",\n  "milestone": "一句话进度说明",\n  "ignoredFindings": [{"id": "#1", "reason": "忽略该非阻塞意见的客观依据"}],\n  "jobs": [\n    {"id": "arch-core", "trade": "architect", "difficulty": "normal", "title": "建立骨架与Lint", "task": "自足任务说明"},\n    {"id": "impl-mod-a", "trade": "builder", "difficulty": "normal", "lockSpec": true, "title": "实现模块A", "task": "自足任务说明"}\n  ]\n}\n\`\`\`\n2. \`"verify"\`：全部实现已合入且必须修均已闭环，进入 Stage 3 全量双轨验证与交付：\n\`\`\`json\n{\n  "action": "verify",\n  "report": "面向用户的 5–8 行改动汇报（做了什么 + 风险提示）",\n  "ignoredFindings": []\n}\n\`\`\`\n3. \`"escalate"\`：发现超出 PLAN_5L.md 边界的重大风险，需请顶层交互者拍板：\n\`\`\`json\n{\n  "action": "escalate",\n  "question": "需要交互者/用户拍板的具体问题与可选方案"\n}\n\`\`\``,
        ].filter(Boolean).join('\n\n');
        writeFileSync(promptFile, prompt);

        const args = state.leadSession
          ? ['--continue', state.leadSession, '--json', '--prompt-file', promptFile]
          : ['--commit', fetchedHead, '--title', `执行主控：${state.title}`, ...agentArgs(settings.lead), '--json', '--prompt-file', promptFile];
        let call = callCodaAgent(args, root);
        if (call.status !== 0 && state.leadSession && !call.parsed?.session) {
          writeFileSync(promptFile, initialContext() + '\n\n' + prompt);
          call = callCodaAgent(['--commit', fetchedHead, '--title', `执行主控：${state.title}`, ...agentArgs(settings.lead), '--json', '--prompt-file', promptFile], root);
        }
        requireValue(call.status === 0 && call.parsed?.session, `执行主控会话调用失败（退出码 ${call.status}）`);

        const decision = extractJsonBlock(call.parsed.answer ?? '');
        requireValue(decision && ['dispatch', 'verify', 'escalate', 'abort'].includes(decision.action), '执行主控未输出合法的 action JSON（dispatch|verify|escalate|abort）');

        const ignored = decision.ignoredFindings ?? [];
        requireValue(Array.isArray(ignored) && ignored.every(item => typeof item?.reason === 'string' && item.reason.trim()), 'ignoredFindings 中每项都须提供非空的客观 reason');
        const nextState = {
          ...state,
          head: fetchedHead,
          round,
          leadSession: call.parsed.session,
          lastLeadHead: fetchedHead,
          ignoredFindings: [...(state.ignoredFindings ?? []), ...ignored],
          pendingFeedback: '',
        };

        if (decision.action === 'dispatch') {
          const jobs = enrichDispatchBatch(decision.jobs, state.ledger, settings);
          mkdirSync(join(env.CODA_ARTIFACTS, 'workers'), { recursive: true });
          mkdirSync(join(env.CODA_ARTIFACTS, 'jobs'), { recursive: true });
          for (const j of jobs) {
            writeFileSync(join(env.CODA_ARTIFACTS, 'jobs', `${round}-${j.id}.json`), JSON.stringify(j, null, 2));
          }
          writeFileSync(join(env.CODA_ARTIFACTS, `batch-${round}.json`), JSON.stringify(jobs, null, 2));
          saveState(nextState);
          appendGithubOutput({
            route: 'dispatch',
            jobs: JSON.stringify(jobs),
            jobIds: jobs.map(j => j.id).join(','),
            milestone: (decision.milestone || '').trim().slice(0, 500),
            round,
            session: env.CODA_THREAD_ID || '',
            escalation: '',
          });
        } else if (decision.action === 'verify') {
          const pending = Object.values(state.ledger).filter(item => item.status === 'rejected' && item.trade !== 'verifier' && !ignored.some(f => f.id === item.id));
          requireValue(!pending.length, `仍有被打回的编码工单：${pending.map(item => item.id).join('、')}。请重派或在 ignoredFindings 按工单 id 写明放弃原因。`);
          if (requestedChanges(state, fetchedHead)) {
            requireValue(ignored.length, '同一提交的 REQUEST_CHANGES 须在本轮 ignoredFindings 中逐条写明不采纳依据');
            const remaining = [...ignored];
            const rulings = state.openReviewFindings.map((finding, idx) => {
              const id = finding.id || `#${idx + 1}`;
              const ruling = remaining.find(f => f.id === id) ?? remaining.find(f => !f.id && finding.title && f.title === finding.title);
              requireValue(ruling, `ignoredFindings 缺少 ${id} ${finding.title} 的不采纳依据`);
              remaining.splice(remaining.indexOf(ruling), 1);
              return { ...ruling, id, title: finding.title };
            });
            if (state.verifiedHead === fetchedHead) {
              nextState.rebuttedReviewHead = fetchedHead;
              nextState.reviewRebuttals = rulings.length ? rulings : ignored;
              nextState.ignoredFindings = [...(state.ignoredFindings ?? []), ...(rulings.length ? remaining : [])];
            }
          }
          nextState.report = (decision.report || state.report || `已完成需求：${state.title}`).trim();
          saveState(nextState);
          appendGithubOutput({ route: 'verify', jobs: '[]', jobIds: '', milestone: '进入双轨验证', escalation: '' });
        } else if (decision.action === 'escalate') {
          const question = String(decision.question || decision.reason || '需要决策层确认方案边界').trim();
          nextState.escalation = question;
          saveState(nextState);
          appendGithubOutput({ route: 'escalate', jobs: '[]', jobIds: '', milestone: '', escalation: question });
        } else {
          nextState.abortReason = String(decision.reason || '主控中止执行').trim();
          saveState(nextState);
          appendGithubOutput({ route: 'abort', jobs: '[]', jobIds: '', milestone: '', escalation: nextState.abortReason });
        }
        break;
      }

      case 'worker': {
        const root = repo();
        const job = env.JOB
          ? JSON.parse(env.JOB)
          : JSON.parse(readFileSync(join(env.CODA_ARTIFACTS, 'jobs', `${state.round}-${env.JOB_ID}.json`), 'utf8'));
        const outDir = join(env.CODA_ARTIFACTS, 'workers');
        mkdirSync(outDir, { recursive: true });
        const resultFile = join(outDir, `${state.round}-${job.id}.json`);

        const baseHead = fetchHead(state.remote, state.reqBranch);
        const upstreamCommit = job.trade === 'verifier' ? '' : fetchHead(state.remote, state.base);
        git('checkout', '-B', `worker-${job.id}`, baseHead);

        const promptFile = join(env.RUNNER_TEMP, `worker-${job.id}.md`);
        const prompt = [
          rolePrompt(job.trade),
          `## 当前项目已启用规范摘要\n${enabledGuidelinesDigest(root)}`,
          `## 工单信息\n- 工单 ID：\`${job.id}\`\n- 工种级别：\`${job.trade} / ${job.tier}\`（${job.agentSummary}，原因：${job.escalationReason}）\n- 标题：${job.title}\n${job.lockSpec ? '- 规约锁定：禁止修改 `.dickda/lints/` 与 `.dickda/verifiers/`\n' : ''}`,
          job.previousFeedback ? `## 前序打回原因（第 ${job.rejections} 次打回）\n${job.previousFeedback}` : '',
          job.previousHead && job.previousRef ? `## 复用前序提交\npreviousHead：${job.previousHead}\n保留分支：${job.previousRef}\n先运行 git fetch ${state.remote} ${job.previousRef}，用 git show ${job.previousHead} 查看改动。可用 git cherry-pick ${job.previousHead} 或挑选其中需要的提交，复用后修订。` : '',
          upstreamCommit ? `处理合并冲突时，可拉取目标分支 ${state.base}，将上游提交 ${upstreamCommit} 合入当前工单。规约锁允许从该提交原样合入的规约。` : '',
          `## 任务书\n${job.task}`,
          job.trade === 'verifier'
            ? `完成后必须在回复最后附上结构化 \`\`\`json 块：\`{"passed": true, "summary": "结论", "findings": [{"level": "must", "title": "...", "detail": "..."}]}\`（未通过必须写 "passed": false）`
            : `完成后确保改动已提交到当前分支（不要推送或开 PR），并以单独一行「交付说明」汇报完成情况与自检命令。`,
        ].filter(Boolean).join('\n\n');
        writeFileSync(promptFile, prompt);

        const call = callCodaAgent([
          '--commit', baseHead,
          '--title', `[${job.trade}/${job.tier}] ${job.title}`,
          ...agentArgs(job.agent),
          '--json',
          '--prompt-file', promptFile,
        ], root);

        const workerHead = job.trade === 'verifier' ? null : call.parsed?.head;
        const isAncestor = !workerHead || spawnSync('git', ['-C', root, 'merge-base', '--is-ancestor', workerHead, baseHead]).status === 0;
        const isStrictDescendant = !isAncestor && spawnSync('git', ['-C', root, 'merge-base', '--is-ancestor', baseHead, workerHead]).status === 0;
        let record;
        if (call.status !== 0 || !call.parsed?.session) {
          record = { ...job, status: 'failed', passed: false, error: `coda-agent 退出码 ${call.status}` };
        } else if (job.trade === 'verifier') {
          const evaluated = evaluateVerifierAnswer(call.parsed.answer ?? '');
          record = {
            ...job,
            status: !evaluated.valid ? 'failed' : evaluated.passed ? 'succeeded' : 'rejected',
            session: call.parsed.session,
            passed: evaluated.passed,
            summary: evaluated.summary,
            findings: evaluated.findings,
            ...(evaluated.error ? { error: evaluated.error } : {}),
          };
        } else {
          if (isAncestor) {
            record = { ...job, status: 'rejected', head: workerHead, error: '工单未产生新的 Git 提交' };
          } else if (!isStrictDescendant) {
            record = { ...job, status: 'rejected', head: workerHead, error: `工单返回的提交（${workerHead}）不是需求分支基线（${baseHead}）的严格后代` };
          } else {
            git('checkout', '--quiet', workerHead);
            const lockCheck = job.lockSpec ? checkSpecLock(root, baseHead, workerHead, { upstreamCommit }) : { ok: true, violations: [] };
            if (!lockCheck.ok) {
              record = {
                ...job,
                status: 'rejected',
                error: `违反规约锁定：实现工单不得擅自修改 ${lockCheck.violations.join('、')}`,
              };
            } else {
              const lintRes = runLints(root);
              if (!lintRes.passed) {
                const detail = lintRes.results.filter(r => !r.passed).map(r => `${r.path}: ${r.output}`).join('; ');
                record = { ...job, status: 'rejected', error: `L2 Executable Lint 未通过：${detail}` };
              } else {
                const jobRef = `dickda/job-${env.GITHUB_RUN_ID}-${job.id}`;
                remoteGit('.', 'push', '--quiet', '--force', '--no-follow-tags', state.remote, `${workerHead}:refs/heads/${jobRef}`);
                record = {
                  ...job,
                  status: 'succeeded',
                  session: call.parsed.session,
                  head: workerHead,
                  jobRef,
                  answer: (call.parsed.answer ?? '').slice(-1500),
                };
              }
            }
          }
        }
        if (isStrictDescendant && (call.status !== 0 || record.status === 'rejected')) {
          record.head = workerHead;
          record.retainedRef = retainWorkerHead(state.remote, job.id, workerHead);
        }
        writeFileSync(resultFile, JSON.stringify(record, null, 2));
        appendGithubOutput({ id: job.id, status: record.status });
        break;
      }

      case 'integrate': {
        // A delivery push and ledger update can succeed before a temporary ref deletion needs retrying.
        if (state.integration?.round === state.round) {
          deleteRefs(state.remote, state.integration.cleanup);
          appendGithubOutput({ head: state.head, changed: state.integration.changed });
          break;
        }
        const root = repo();
        const baseTip = fetchHead(state.remote, state.reqBranch);
        git('checkout', '-B', state.reqBranch, baseTip);

        const workersDir = join(env.CODA_ARTIFACTS, 'workers');
        const prefix = `${state.round}-`;
        const files = existsSync(workersDir)
          ? readdirSync(workersDir).filter(f => f.startsWith(prefix) && f.endsWith('.json')).sort()
          : [];
        const results = files.map(f => JSON.parse(readFileSync(join(workersDir, f), 'utf8')));

        for (const r of results) {
          if (r.jobRef) {
            r.head = fetchHead(state.remote, r.jobRef);
          }
        }

        const merged = integrateWorkerResults(root, baseTip, results, state.ledger ?? {}, settings);
        for (const r of results) {
          if (r.jobRef && merged.ledger[r.id].status === 'rejected') {
            merged.ledger[r.id].lastRejectedRef = retainWorkerHead(state.remote, r.id, r.head);
          }
        }
        if (merged.changed) {
          remoteGit('.', 'push', '--quiet', '--no-follow-tags', state.remote, `${merged.tip}:refs/heads/${state.reqBranch}`);
        }
        const cleanup = [...releasePreviousRefs(merged.ledger), ...results.filter(r => r.jobRef).map(r => `refs/heads/${r.jobRef}`)];

        const feedbackParts = [];
        if (merged.landed.length) feedbackParts.push(`已合入工单：${merged.landed.map(l => `${l.id}(${l.trade}/${l.tier})`).join('、')}`);
        if (merged.rejected.length) feedbackParts.push(`未通过工单：\n${merged.rejected.map(r => `- ${r.id}（累计未通过 ${r.rejections} 次${r.nextTier === 'senior' ? '，下次派单自动升级 senior' : ''}）：${r.reason}`).join('\n')}`);
        if (merged.findings.length) feedbackParts.push(`验证工种（Sol）报告的问题：\n${merged.findings.map((f, idx) => `- #${idx + 1} [${f.level ?? 'must'}] ${f.title ?? ''}：${f.detail ?? ''}`).join('\n')}`);

        saveState({
          ...state,
          head: merged.tip,
          ledger: merged.ledger,
          integration: { round: state.round, changed: merged.changed, cleanup },
          pendingFeedback: feedbackParts.join('\n\n'),
        });
        deleteRefs(state.remote, cleanup);
        appendGithubOutput({ head: merged.tip, changed: merged.changed });
        break;
      }

      case 'checks-passed': {
        const runs = env.RUNS ? JSON.parse(env.RUNS) : [];
        saveState({ ...state, checks: { head: state.head, runs } });
        break;
      }

      case 'checks-failed': {
        const step = env.STEP || '项目检查';
        const msg = `${step}未通过（提交 ${state.head}，运行 coda://workflow-runs/${env.GITHUB_RUN_ID}）。请检查失败日志并派单修复。${env.LINES ? `\n${env.LINES}` : ''}`;
        saveState({ ...state, pendingFeedback: [state.pendingFeedback, msg].filter(Boolean).join('\n\n') });
        break;
      }

      case 'escalated': {
        const reply = JSON.parse(env.ESCALATE || '{}');
        if (reply.choice === 'stop') {
          appendGithubOutput({ route: 'stop' });
          break;
        }
        const msg = `顶层交互者对风险升级的指示：\n${reply.note || '请按当前边界继续推进'}`;
        saveState({ ...state, pendingFeedback: [state.pendingFeedback, msg].filter(Boolean).join('\n\n') });
        appendGithubOutput({ route: 'continue' });
        break;
      }

      case 'archive-delivery': {
        const root = repo();
        let head = fetchHead(state.remote, state.reqBranch);
        git('checkout', '-B', state.reqBranch, head);

        let lastArchive = state.lastArchive || '';
        const archived = remember(root);
        if (archived.archived) {
          git('add', '-A', '.dickda/learning', '.dickda/tasks/logs');
          git('commit', '-m', `chore(dickda): archive investigation log (${archived.path})`);
          head = git('rev-parse', 'HEAD');
          remoteGit('.', 'push', '--quiet', '--no-follow-tags', state.remote, `${head}:refs/heads/${state.reqBranch}`);
          lastArchive = archived.path;
        }

        const nextState = { ...state, head, lastArchive };
        saveState(nextState);
        appendGithubOutput({
          head,
          needChecks: nextState.checks?.head !== head,
        });
        break;
      }

      case 'prepare-verify': {
        const resolved = resolveEngineer('verifier', {
          difficulty: Object.values(state.ledger ?? {}).some(i => i.tier === 'senior') ? 'hard' : 'normal',
        }, settings);
        appendGithubOutput({
          head: state.head,
          ...reviewRange(state),
          skipReview: state.verifiedHead === state.head && state.rebuttedReviewHead === state.head && requestedChanges(state, state.head),
          tier: resolved.tier,
          task: `# ${state.title}\n\n${state.goal}`,
          evidence: checkRunsText(state.checks, state.head),
        });
        break;
      }

      case 'review-lost': {
        const reason = `提交 ${state.head} 调用 review-commit 能力异常失败（运行 coda://workflow-runs/${env.GITHUB_RUN_ID}），尚未完成独立代码审查，不能放行交付。`;
        saveState({ ...state, reviewRetryReason: reason });
        appendGithubOutput({ reason });
        break;
      }

      case 'verified': {
        const verifyCommit = (env.VERIFY_COMMIT || '').trim();
        const verifyPassed = env.VERIFY_PASSED === 'true';
        const next = {
          ...state,
          verifiedHead: verifyPassed && verifyCommit === state.head ? state.head : '',
          verifyReport: env.VERIFY_REPORT || '',
          verifyFindings: env.VERIFY_FINDINGS || '',
          verifyEvidence: env.VERIFY_EVIDENCE || '',
          rebuttedReviewHead: '',
        };
        let review = null;
        if (next.verifiedHead && env.REVIEW?.trim()) {
          try { review = JSON.parse(env.REVIEW); } catch { review = null; }
        }
        const gate = evaluateVerificationGate({
          head: state.head,
          verifyCommit,
          verifyPassed,
          verifyReport: dualReport(next),
          review,
        });

        if (next.verifiedHead && gate.route !== 'retry') {
          next.review = review;
          next.lastReviewedHead = review.head;
          next.openReviewFindings = openMusts(review, jsonList(env.PREVIOUS) ?? []);
          if (next.openReviewFindings.length) {
            gate.reason += '\n' + next.openReviewFindings.map((f, i) => `- ${f.id || `#${i + 1}`} ${f.title}（${f.location ?? ''}）：${f.detail ?? ''}`).join('\n');
          }
        }
        if (gate.route === 'lead') {
          next.pendingFeedback = gate.reason;
          saveState(next);
          appendGithubOutput({ route: 'lead', reason: gate.reason });
          break;
        }
        if (gate.route === 'retry') {
          next.reviewRetryReason = gate.reason;
          saveState(next);
          appendGithubOutput({ route: 'retry', reason: gate.reason });
          break;
        }
        saveState(next);
        appendGithubOutput({ route: 'pr', reason: '' });
        break;
      }

      case 'pr': {
        deleteRefs(state.remote, releasePreviousRefs(state.ledger, true));
        const bodyFile = join(env.CODA_ARTIFACTS, 'pull-request.md');
        const prSummary = buildPrSummary(state);
        writeFileSync(bodyFile, prSummary);

        let pr = state.pr;
        if (pr) {
          privateGh('pr', 'edit', pr, '--body-file', bodyFile);
        } else {
          const existing = JSON.parse(privateGh('pr', 'list', '--repo', state.remote, '--head', state.reqBranch, '--base', state.base, '--state', 'open', '--json', 'url'));
          pr = existing[0]?.url || privateGh('pr', 'create', '--repo', state.remote, '--base', state.base, '--head', state.reqBranch, '--title', state.title, '--body-file', bodyFile);
        }
        saveState({ ...state, pr });
        appendGithubOutput({
          url: pr,
          head: state.head,
          summary: prSummary,
          device: env.DEVICES === 'true' && state.acceptedHead !== state.head,
        });
        break;
      }

      case 'accepted': {
        if (env.ROUTE === 'changed') {
          saveState({ ...state, pendingFeedback: '预览准备阶段需要调整，请继续修复并合入需求分支。' });
          appendGithubOutput({ route: 'lead' });
          break;
        }
        const reply = JSON.parse(env.DEVICE || '{}');
        if (env.ROUTE === 'failed') {
          saveState({
            ...state,
            pendingFeedback: `用户设备验收未通过（提交 ${state.head}）：\n${reply.note ?? ''}`,
          });
          appendGithubOutput({ route: 'lead' });
          break;
        }
        saveState({ ...state, acceptedHead: state.head, acceptance: reply.note || '用户设备验收通过' });
        appendGithubOutput({ route: 'premerge' });
        break;
      }

      case 'approval-check': {
        checkApprovalPr(state);
        appendGithubOutput({ summary: buildPrSummary(state) });
        break;
      }

      case 'merge': {
        deleteRefs(state.remote, releasePreviousRefs(state.ledger, true));
        const result = mergeApprovedPr(state, settings.mergeMethod);
        if (result.route === 'conflict') {
          saveState({ ...state, pendingFeedback: `PR ${state.pr} 与 ${state.base} 存在合并冲突，请同步目标分支并解决冲突后重验。` });
        }
        appendGithubOutput(result);
        break;
      }

      case 'stopped': {
        const reason = env.REASON?.trim() || '用户暂不开工，保留需求分支方案。';
        saveState({ ...state, stopReason: reason });
        if (env.GITHUB_STEP_SUMMARY) writeFileSync(env.GITHUB_STEP_SUMMARY, `## 停止交付\n\n${reason}\n\n保留分支：\`${state.reqBranch}\`\n`, { flag: 'a' });
        appendGithubOutput({ reason });
        break;
      }

      default:
        throw new Error(`未知 dickda-develop 步骤：${action}`);
    }
  } catch (error) {
    console.error(`dickda-develop: ${error.message}`);
    process.exitCode = 1;
  }
}
