import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkSpecLock, remember, runLints } from './assets.mjs';
import { enabledGuidelinesDigest } from './prompts.mjs';
import { TRADES, agentArgs, formatAgent, loadSettings, resolveEngineer, rolePrompt } from './roles.mjs';
import { appendGithubOutput, atomic, init, inside, managed, projectGroup, repo, requireValue } from './store.mjs';
import { extractJsonBlock } from './verify.mjs';

function runCmd(bin, args, options = {}) {
  return execFileSync(bin, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    ...options,
  }).trim();
}

const git = (...args) => runCmd('git', args);
const gh = (...args) => runCmd('gh', args);

// Strip CODA_THREAD_ID so PR operations belong exclusively to dickda-develop and do not trigger duplicate PR lifecycles.
function privateGh(...args) {
  const { CODA_THREAD_ID: _thread, ...privateEnv } = process.env;
  return runCmd('gh', args, { env: privateEnv });
}

function parseOverrideAgent(raw) {
  if (!raw) return undefined;
  const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  return parsed && typeof parsed === 'object' && parsed.agent ? parsed : undefined;
}

export function effectiveSettings(env = process.env) {
  return loadSettings(env.CODA_PLUGIN_SETTINGS, {
    'dickda-develop.thinker': parseOverrideAgent(env.THINKER),
    'dickda-develop.lead': parseOverrideAgent(env.LEAD),
    'dickda-develop.architectStandard': parseOverrideAgent(env.ARCHITECT),
    'dickda-develop.architectSenior': parseOverrideAgent(env.ARCHITECT_SENIOR),
    'dickda-develop.builderStandard': parseOverrideAgent(env.BUILDER),
    'dickda-develop.builderSenior': parseOverrideAgent(env.BUILDER_SENIOR),
    'dickda-develop.verifierStandard': parseOverrideAgent(env.VERIFIER),
    'dickda-develop.verifierSenior': parseOverrideAgent(env.VERIFIER_SENIOR),
  });
}

export function enrichDispatchBatch(rawJobs, ledger = {}, settings = loadSettings()) {
  requireValue(Array.isArray(rawJobs) && rawJobs.length >= 1 && rawJobs.length <= 12, 'dispatch 批次须包含 1–12 个并发工单');
  const seen = new Set();
  return rawJobs.map((job, idx) => {
    const jobId = String(job.id || `job-${idx + 1}`).trim();
    requireValue(/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(jobId), `工单 ID 不合法：${jobId}`);
    requireValue(!seen.has(jobId), `同一并发批次内工单 ID 重复：${jobId}`);
    seen.add(jobId);
    requireValue(TRADES.includes(job.trade), `工单 ${jobId} 的工种须为 architect、builder 或 verifier`);
    requireValue(typeof job.title === 'string' && job.title.trim(), `工单 ${jobId} 缺少 title`);
    requireValue(typeof job.task === 'string' && job.task.trim(), `工单 ${jobId} 缺少 task`);

    const prev = ledger[jobId] ?? { rejections: 0 };
    const difficulty = job.difficulty === 'hard' ? 'hard' : 'normal';
    const resolved = resolveEngineer(job.trade, {
      tier: job.tier,
      difficulty,
      rejections: prev.rejections ?? 0,
    }, settings);

    return {
      id: jobId,
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
      previousFeedback: prev.lastFeedback ?? '',
    };
  });
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
    const entry = ledger[w.id] ?? { id: w.id, trade: w.trade, title: w.title, rejections: 0, status: 'pending' };
    if (w.trade === 'verifier') {
      if (w.status === 'succeeded') {
        entry.status = 'verified';
        entry.lastAnswer = w.summary ?? '';
        for (const f of w.findings ?? []) findings.push({ ...f, sourceJob: w.id, verifier: w.agentSummary });
      } else {
        entry.rejections = (entry.rejections ?? 0) + 1;
        entry.status = 'rejected';
        entry.lastFeedback = w.error || '验证会话执行失败';
        rejected.push({ id: w.id, reason: entry.lastFeedback, rejections: entry.rejections });
      }
      ledger[w.id] = entry;
      continue;
    }

    if (w.status !== 'succeeded' || !w.head) {
      entry.rejections = (entry.rejections ?? 0) + 1;
      entry.status = 'rejected';
      entry.lastRejectedHead = w.head ?? null;
      entry.lastFeedback = w.error || '未产出有效提交';
      const next = resolveEngineer(w.trade, { difficulty: w.difficulty, rejections: entry.rejections }, settings);
      entry.nextTier = next.tier;
      ledger[w.id] = entry;
      rejected.push({ id: w.id, reason: entry.lastFeedback, rejections: entry.rejections, nextTier: next.tier });
      continue;
    }

    if (tip === baseTip) {
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
      entry.lastFeedback = `并发合入冲突（冲突文件：${conflictFiles.join('、') || '未知'}），请基于最新需求分支重新实现`;
      const next = resolveEngineer(w.trade, { difficulty: w.difficulty, rejections: entry.rejections }, settings);
      entry.nextTier = next.tier;
      ledger[w.id] = entry;
      rejected.push({ id: w.id, reason: entry.lastFeedback, rejections: entry.rejections, nextTier: next.tier });
    }
  }

  return { tip, changed: tip !== baseTip, landed, rejected, findings, ledger };
}

function callCodaAgent(args, cwd = process.cwd()) {
  const res = spawnSync('coda-agent', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  if (res.error) throw res.error;
  let parsed = null;
  try { parsed = JSON.parse(res.stdout); } catch {}
  return { status: res.status ?? 1, stdout: res.stdout, parsed };
}

function checkRunsText(record, head) {
  if (!record || record.head !== head) return '当前提交尚未完成项目检查。';
  const runs = typeof record.runs === 'string' ? JSON.parse(record.runs) : (record.runs ?? []);
  return runs.map(r => `- ${r.workflow}：${r.state} coda://workflow-runs/${r.runId}`).join('\n') || '项目未声明 check 挂点流程。';
}

export function buildPrSummary(state) {
  const landedLines = Object.values(state.ledger ?? {})
    .filter(item => item.status === 'landed')
    .map(item => `- [${item.trade}/${item.tier}] ${item.id} · ${item.title}（${item.agentSummary ?? ''}）`);
  const ignoredLines = (state.ignoredFindings ?? [])
    .map(item => `- ${item.id || item.title}：${item.reason}`);

  return [
    state.report || `需求：${state.title}`,
    `### 五层交付证据（提交 \`${state.head}\`）`,
    `#### 项目检查（L2）\n${checkRunsText(state.checks, state.head)}`,
    state.verifyReport ? `#### 结果导向双轨验证（L3）\n${state.verifyReport}` : '',
    state.review?.head === state.head ? `#### 独立代码评审（Sol）\n${state.review.line}\n${state.review.report ?? ''}` : '',
    landedLines.length ? `#### 已合入工单\n${landedLines.join('\n')}` : '',
    ignoredLines.length ? `#### 主控裁定忽略的非阻塞项及依据\n${ignoredLines.join('\n')}` : '',
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const env = process.env;
    const action = process.argv[2];
    const stateFile = join(env.CODA_ARTIFACTS, 'develop.json');
    const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : null;
    const saveState = next => writeFileSync(stateFile, `${JSON.stringify(next, null, 2)}\n`);
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
        git('fetch', '--quiet', remote, base);
        const baseCommit = git('rev-parse', 'FETCH_HEAD');

        let startCommit = baseCommit;
        if (env.BRANCH && env.BRANCH.trim() && env.BRANCH.trim() !== base) {
          startCommit = git('rev-parse', '--verify', `refs/heads/${env.BRANCH.trim()}^{commit}`);
        }
        const reqBranch = `dickda/req-${env.GITHUB_RUN_ID}`;
        git('push', '--quiet', '--force', '--no-follow-tags', remote, `${startCommit}:refs/heads/${reqBranch}`);

        const rawGoal = (env.GOAL || '').trim();
        const rawTitle = (env.TITLE || '').trim() || rawGoal.split(/\r?\n/)[0]?.slice(0, 80) || '';
        const group = projectGroup(root);
        const initial = {
          remote,
          defaultBranch,
          base,
          baseCommit,
          reqBranch,
          head: startCommit,
          group,
          title: rawTitle,
          goal: rawGoal,
          round: 0,
          leadSession: null,
          ledger: {},
          ignoredFindings: [],
          pendingFeedback: '',
          pr: '',
          acceptedHead: '',
        };
        saveState(initial);
        appendGithubOutput({
          group,
          reqBranch,
          base,
          baseCommit,
          needBrief: !rawGoal,
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
        const next = { ...state, title, goal };
        saveState(next);
        appendGithubOutput({ route: 'ok', feedback: '' });
        break;
      }

      case 'seed': {
        const root = repo();
        git('fetch', '--quiet', state.remote, state.reqBranch);
        git('checkout', '-B', state.reqBranch, 'FETCH_HEAD');
        init(root);
        atomic(managed(root, 'tasks/TODO_TASK.md'), `# ${state.title}\n\n${state.goal}\n`);
        git('add', '.dickda');
        if (git('status', '--porcelain', '--', '.dickda')) {
          git('commit', '-m', `chore(dickda): initialize .dickda assets for ${state.title}`);
          const head = git('rev-parse', 'HEAD');
          git('push', '--quiet', '--no-follow-tags', state.remote, `${head}:refs/heads/${state.reqBranch}`);
          saveState({ ...state, head });
        }
        appendGithubOutput({ head: state.head });
        break;
      }

      case 'think': {
        const root = repo();
        git('fetch', '--quiet', state.remote, state.reqBranch);
        git('checkout', '-B', state.reqBranch, 'FETCH_HEAD');
        const promptFile = join(env.RUNNER_TEMP, 'thinker.md');
        const prompt = [
          rolePrompt('thinker'),
          `## 当前项目已启用规范摘要\n${enabledGuidelinesDigest(root)}`,
          `## 本次需求原文（.dickda/tasks/TODO_TASK.md）\n${readFileSync(managed(root, 'tasks/TODO_TASK.md'), 'utf8')}`,
          `请将完整的五层技术方案写入 \`.dickda/tasks/PLAN_5L.md\` 并提交到当前分支（不要推送或开 PR），最后简要汇报五层核心设计。`,
        ].join('\n\n');
        writeFileSync(promptFile, prompt);
        const call = callCodaAgent([
          '--commit', state.head,
          '--title', `思考者规划：${state.title}`,
          ...agentArgs(settings.thinker),
          '--json',
          '--prompt-file', promptFile,
        ], root);
        requireValue(call.status === 0 && call.parsed?.head, `思考者会话未成功产出五层方案提交（退出码 ${call.status}）`);
        git('push', '--quiet', '--force', '--no-follow-tags', state.remote, `${call.parsed.head}:refs/heads/${state.reqBranch}`);
        saveState({ ...state, head: call.parsed.head, planAnswer: call.parsed.answer ?? '' });
        appendGithubOutput({ head: call.parsed.head });
        break;
      }

      case 'lead-plan': {
        const root = repo();
        git('fetch', '--quiet', state.remote, state.reqBranch);
        git('checkout', '-B', state.reqBranch, 'FETCH_HEAD');
        const round = (state.round ?? 0) + 1;
        const planBody = existsSync(managed(root, 'tasks/PLAN_5L.md')) ? readFileSync(managed(root, 'tasks/PLAN_5L.md'), 'utf8') : '';
        const ledgerSummary = Object.values(state.ledger ?? {}).map(item =>
          `- ${item.id} [${item.trade}] status=${item.status}, rejections=${item.rejections ?? 0}${item.nextTier === 'senior' ? '（下次派单将自动升级为高级工程师）' : ''}${item.lastFeedback ? ` — 反馈：${item.lastFeedback}` : ''}`
        ).join('\n') || '尚无工单记录。';

        const promptFile = join(env.RUNNER_TEMP, `lead-${round}.md`);
        const prompt = [
          ...(state.leadSession ? [] : [rolePrompt('lead')]),
          `## 第 ${round} 轮主控决策上下文`,
          `- 需求分支：\`${state.reqBranch}\`，当前 HEAD：\`${state.head}\``,
          `- 自动升级阈值：常规工程师连续被打回 >= ${settings.escalationThreshold} 次自动升级高级工程师`,
          `- 可用工种级别：\n  - architect：常规 ${formatAgent(settings.architect.standard)} ｜ 高级 ${formatAgent(settings.architect.senior)}\n  - builder：常规 ${formatAgent(settings.builder.standard)} ｜ 高级 ${formatAgent(settings.builder.senior)}\n  - verifier：常规 ${formatAgent(settings.verifier.standard)} ｜ 高级 ${formatAgent(settings.verifier.senior)}`,
          ...(state.leadSession ? [] : [`## 需求原文\n${state.goal}`, `## 五层技术方案（PLAN_5L.md）\n${planBody}`]),
          `## 工单账本状态\n${ledgerSummary}`,
          state.pendingFeedback ? `## 最新待裁决反馈 / 检查与审查结果\n${state.pendingFeedback}` : '',
          `## 输出格式要求（严格遵守）\n请在回复末尾输出一个 \`\`\`json 代码块，action 取值之一：\n1. \`"dispatch"\`：并发派发 1–12 个无相互阻塞依赖的工单（可同时涵盖 architect / builder / verifier）：\n\`\`\`json\n{\n  "action": "dispatch",\n  "milestone": "一句话进度说明",\n  "ignoredFindings": [{"id": "#1", "reason": "忽略该非阻塞意见的客观依据"}],\n  "jobs": [\n    {"id": "arch-core", "trade": "architect", "difficulty": "normal", "title": "建立骨架与Lint", "task": "自足任务说明"},\n    {"id": "impl-mod-a", "trade": "builder", "difficulty": "normal", "lockSpec": true, "title": "实现模块A", "task": "自足任务说明"}\n  ]\n}\n\`\`\`\n2. \`"verify"\`：全部实现已合入且必须修均已闭环，进入 Stage 3 全量双轨验证与交付：\n\`\`\`json\n{\n  "action": "verify",\n  "report": "面向用户的 5–8 行改动汇报（做了什么 + 风险提示）",\n  "ignoredFindings": []\n}\n\`\`\`\n3. \`"escalate"\`：发现超出 PLAN_5L.md 边界的重大风险，需请顶层交互者拍板：\n\`\`\`json\n{\n  "action": "escalate",\n  "question": "需要交互者/用户拍板的具体问题与可选方案"\n}\n\`\`\``,
        ].filter(Boolean).join('\n\n');
        writeFileSync(promptFile, prompt);

        const args = state.leadSession
          ? ['--continue', state.leadSession, '--json', '--prompt-file', promptFile]
          : ['--commit', state.head, '--title', `执行主控：${state.title}`, ...agentArgs(settings.lead), '--json', '--prompt-file', promptFile];
        let call = callCodaAgent(args, root);
        if (call.status !== 0 && state.leadSession && !call.parsed?.session) {
          call = callCodaAgent(['--commit', state.head, '--title', `执行主控：${state.title}`, ...agentArgs(settings.lead), '--json', '--prompt-file', promptFile], root);
        }
        requireValue(call.status === 0 && call.parsed?.session, `执行主控会话调用失败（退出码 ${call.status}）`);

        const decision = extractJsonBlock(call.parsed.answer ?? '');
        requireValue(decision && ['dispatch', 'verify', 'escalate', 'abort'].includes(decision.action), '执行主控未输出合法的 action JSON（dispatch|verify|escalate|abort）');

        const mergedIgnored = [...(state.ignoredFindings ?? []), ...(decision.ignoredFindings ?? [])];
        const nextState = {
          ...state,
          round,
          leadSession: call.parsed.session,
          ignoredFindings: mergedIgnored,
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
            milestone: decision.milestone || `第 ${round} 轮并发派发 ${jobs.length} 项工单`,
            escalation: '',
          });
        } else if (decision.action === 'verify') {
          nextState.report = (decision.report || state.report || `已完成需求：${state.title}`).trim();
          saveState(nextState);
          appendGithubOutput({ route: 'verify', jobs: '[]', jobIds: '', milestone: '进入双轨验证', escalation: '' });
        } else if (decision.action === 'escalate') {
          const question = String(decision.question || decision.reason || '需要决策层确认方案边界').trim();
          nextState.escalation = question;
          saveState(nextState);
          appendGithubOutput({ route: 'escalate', jobs: '[]', jobIds: '', escalation: question });
        } else {
          nextState.abortReason = String(decision.reason || '主控中止执行').trim();
          saveState(nextState);
          appendGithubOutput({ route: 'abort', jobs: '[]', jobIds: '', escalation: nextState.abortReason });
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

        git('fetch', '--quiet', state.remote, state.reqBranch);
        const baseHead = git('rev-parse', 'FETCH_HEAD');
        git('checkout', '-B', `worker-${job.id}`, baseHead);

        const promptFile = join(env.RUNNER_TEMP, `worker-${job.id}.md`);
        const prompt = [
          rolePrompt(job.trade),
          `## 当前项目已启用规范摘要\n${enabledGuidelinesDigest(root)}`,
          `## 工单信息\n- 工单 ID：\`${job.id}\`\n- 工种级别：\`${job.trade} / ${job.tier}\`（${job.agentSummary}，原因：${job.escalationReason}）\n- 标题：${job.title}\n${job.lockSpec ? '- 规约锁定：禁止修改 `.dickda/lints/` 与 `.dickda/verifiers/`\n' : ''}`,
          job.previousFeedback ? `## 前序打回原因（第 ${job.rejections} 次打回）\n${job.previousFeedback}` : '',
          `## 任务书\n${job.task}`,
          job.trade === 'verifier'
            ? `完成后在最后附上 \`\`\`json 块：\`{"passed": true, "summary": "结论", "findings": [{"level": "must", "title": "...", "detail": "..."}]}\``
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

        let record;
        if (call.status !== 0 || !call.parsed?.session) {
          record = { ...job, status: 'failed', error: `coda-agent 退出码 ${call.status}` };
        } else if (job.trade === 'verifier') {
          const verdict = extractJsonBlock(call.parsed.answer ?? '') ?? { passed: true, summary: (call.parsed.answer ?? '').slice(-600), findings: [] };
          record = {
            ...job,
            status: 'succeeded',
            session: call.parsed.session,
            passed: Boolean(verdict.passed),
            summary: verdict.summary ?? '',
            findings: verdict.findings ?? [],
          };
        } else {
          const workerHead = call.parsed.head;
          const isAncestor = !workerHead || spawnSync('git', ['-C', root, 'merge-base', '--is-ancestor', workerHead, baseHead]).status === 0;
          if (isAncestor) {
            record = { ...job, status: 'rejected', head: workerHead, error: '工单未产生新的 Git 提交' };
          } else {
            const tempWork = root;
            git('checkout', '--quiet', workerHead);
            const lockCheck = job.lockSpec ? checkSpecLock(tempWork, baseHead, workerHead) : { ok: true, violations: [] };
            if (!lockCheck.ok) {
              record = {
                ...job,
                status: 'rejected',
                head: workerHead,
                error: `违反规约锁定：实现工单不得擅自修改 ${lockCheck.violations.join('、')}`,
              };
            } else {
              const lintRes = runLints(tempWork);
              if (!lintRes.passed) {
                const detail = lintRes.results.filter(r => !r.passed).map(r => `${r.path}: ${r.output}`).join('; ');
                record = { ...job, status: 'rejected', head: workerHead, error: `L2 Executable Lint 未通过：${detail}` };
              } else {
                const jobRef = `dickda/job-${env.GITHUB_RUN_ID}-${job.id}`;
                git('push', '--quiet', '--force', '--no-follow-tags', state.remote, `${workerHead}:refs/heads/${jobRef}`);
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
        writeFileSync(resultFile, JSON.stringify(record, null, 2));
        appendGithubOutput({ id: job.id, status: record.status });
        break;
      }

      case 'integrate': {
        const root = repo();
        git('fetch', '--quiet', state.remote, state.reqBranch);
        const baseTip = git('rev-parse', 'FETCH_HEAD');
        git('checkout', '-B', state.reqBranch, baseTip);

        const workersDir = join(env.CODA_ARTIFACTS, 'workers');
        const prefix = `${state.round}-`;
        const files = existsSync(workersDir)
          ? readdirSync(workersDir).filter(f => f.startsWith(prefix) && f.endsWith('.json')).sort()
          : [];
        const results = files.map(f => JSON.parse(readFileSync(join(workersDir, f), 'utf8')));

        for (const r of results) {
          if (r.jobRef) {
            git('fetch', '--quiet', state.remote, r.jobRef);
            r.head = git('rev-parse', 'FETCH_HEAD');
          }
        }

        const merged = integrateWorkerResults(root, baseTip, results, state.ledger ?? {}, settings);
        if (merged.changed) {
          git('push', '--quiet', '--force', '--no-follow-tags', state.remote, `${merged.tip}:refs/heads/${state.reqBranch}`);
        }
        for (const r of results) {
          if (r.jobRef) {
            spawnSync('git', ['push', '--quiet', state.remote, '--delete', `refs/heads/${r.jobRef}`], { stdio: 'ignore' });
          }
        }

        const feedbackParts = [];
        if (merged.landed.length) feedbackParts.push(`已合入工单：${merged.landed.map(l => `${l.id}(${l.trade}/${l.tier})`).join('、')}`);
        if (merged.rejected.length) feedbackParts.push(`被打回工单：\n${merged.rejected.map(r => `- ${r.id}（累计打回 ${r.rejections} 次${r.nextTier === 'senior' ? '，建议/自动升级 senior' : ''}）：${r.reason}`).join('\n')}`);
        if (merged.findings.length) feedbackParts.push(`验证工种（Sol）报告的问题：\n${merged.findings.map((f, idx) => `- #${idx + 1} [${f.level ?? 'must'}] ${f.title ?? ''}：${f.detail ?? ''}`).join('\n')}`);

        const next = {
          ...state,
          head: merged.tip,
          ledger: merged.ledger,
          pendingFeedback: feedbackParts.join('\n\n'),
        };
        saveState(next);
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

      case 'prepare-verify': {
        const resolved = resolveEngineer('verifier', {
          difficulty: Object.values(state.ledger ?? {}).some(i => i.tier === 'senior') ? 'hard' : 'normal',
        }, settings);
        appendGithubOutput({
          head: state.head,
          base: state.baseCommit,
          tier: resolved.tier,
          reviewer: JSON.stringify(resolved.agent),
          task: `# ${state.title}\n\n${state.goal}`,
          evidence: checkRunsText(state.checks, state.head),
        });
        break;
      }

      case 'verified': {
        const dualPassed = env.VERIFY_PASSED === 'true';
        const verifyReport = env.VERIFY_REPORT || '';
        const review = env.REVIEW ? JSON.parse(env.REVIEW) : null;
        const reviewFailed = review && (review.decision === 'REQUEST_CHANGES' || review.decision === 'INCOMPLETE');

        const next = { ...state, verifyReport, ...(review ? { review: { ...review, head: state.head } } : {}) };
        if (!dualPassed || reviewFailed) {
          const reasons = [];
          if (!dualPassed) reasons.push(`### 双轨验证未通过\n${verifyReport}`);
          if (reviewFailed) reasons.push(`### 独立代码审查（Sol）结论：${review.decision}\n${review.line ?? ''}\n${review.report ?? ''}`);
          next.pendingFeedback = reasons.join('\n\n');
          saveState(next);
          appendGithubOutput({ route: 'lead' });
          break;
        }
        saveState(next);
        appendGithubOutput({ route: 'pr' });
        break;
      }

      case 'pr': {
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
        const live = JSON.parse(privateGh('pr', 'view', state.pr, '--json', 'headRefOid,baseRefName,state'));
        const defaultBranch = gh('repo', 'view', state.remote, '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name');
        requireValue(live.state === 'OPEN' && live.headRefOid === state.head, 'PR 已关闭或提交发生变动，拒绝批准未经验证的提交');
        requireValue(live.baseRefName === state.base && state.base === defaultBranch, '仅允许合入仓库默认分支');
        appendGithubOutput({ summary: buildPrSummary(state) });
        break;
      }

      case 'merge': {
        const live = JSON.parse(privateGh('pr', 'view', state.pr, '--json', 'state,headRefOid,baseRefName,mergeCommit'));
        const defaultBranch = gh('repo', 'view', state.remote, '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name');
        requireValue(live.headRefOid === state.head, '批准后 PR 提交已改变，拒绝合并');
        requireValue(live.baseRefName === state.base && state.base === defaultBranch, '仅允许合入仓库默认分支');
        if (live.state === 'MERGED') {
          appendGithubOutput({ route: 'merged', commit: live.mergeCommit.oid });
          break;
        }
        requireValue(live.state === 'OPEN', 'PR 已关闭但未合并');

        const method = settings.mergeMethod;
        const { CODA_THREAD_ID: _thread, ...privateEnv } = env;
        const done = spawnSync('gh', ['pr', 'merge', state.pr, '--repo', state.remote, `--${method}`, '--match-head-commit', state.head, '--delete-branch'], {
          encoding: 'utf8',
          env: privateEnv,
        });
        if (done.error) throw done.error;
        const after = JSON.parse(privateGh('pr', 'view', state.pr, '--json', 'state,mergeable,mergeCommit'));
        if (after.state === 'MERGED') {
          const root = repo();
          try {
            if (existsSync(managed(root, 'tasks/logs/investigate.md'))) remember(root);
          } catch {}
          appendGithubOutput({ route: 'merged', commit: after.mergeCommit.oid });
        } else if (after.state === 'OPEN' && after.mergeable === 'CONFLICTING') {
          saveState({ ...state, pendingFeedback: `PR ${state.pr} 与 ${state.base} 存在合并冲突，请同步目标分支并解决冲突后重验。` });
          appendGithubOutput({ route: 'conflict', commit: '' });
        } else {
          throw new Error(`合并未完成：${after.state} ${done.stderr || done.stdout}`);
        }
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
