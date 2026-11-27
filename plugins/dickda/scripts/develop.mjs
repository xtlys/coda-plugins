import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { agentFailure, agentResult, callCodaAgent, callCodaAgentAsync, callDeliveryAgent, callDeliveryAgentAsync } from './agent.mjs';
import { checkApprovalPr, mergeApprovedPr, privateGh } from './approval.mjs';
import { checkSpecLock, remember, runLints } from './assets.mjs';
import { enabledGuidelinesDigest } from './prompts.mjs';
import { checkRunsText, jsonList, openMusts, requestedChanges, reviewRange, reviewVerdict } from './review.mjs';
import { TRADES, agentArgs, effectiveSettings, formatAgent, loadSettings, resolveEngineer, rolePrompt } from './roles.mjs';
import { DEFAULT_PLAN, INVESTIGATE_MARKER, appendGithubOutput, atomic, hash, init, managed, projectGroup, remoteGit, repo, requireValue, runtime, save } from './store.mjs';
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
const isAncestor = (base, head) => spawnSync('git', ['merge-base', '--is-ancestor', base, head]).status === 0;

function fetchHead(remote, branch) {
  remoteGit('.', 'fetch', '--quiet', remote, `refs/heads/${branch}`);
  return git('rev-parse', 'FETCH_HEAD');
}

function releasePreviousRefs(ledger, all = false) {
  const entries = Object.values(ledger).filter(item => all || ['landed', 'replaced'].includes(item.status));
  const refs = [...new Set(entries.flatMap(item => [item.lastRejectedRef, ...item.retainedRefs ?? []]).filter(Boolean))];
  for (const item of entries) {
    delete item.lastRejectedRef;
    delete item.retainedRefs;
  }
  return refs;
}

function deleteRefs(remote, refs) {
  if (refs.length) remoteGit('.', 'push', '--quiet', '--no-follow-tags', remote, ...refs.map(ref => `:${ref}`));
}

export function enrichDispatchBatch(rawJobs, ledger = {}, settings = loadSettings()) {
  requireValue(Array.isArray(rawJobs) && rawJobs.length >= 1 && rawJobs.length <= 12, 'dispatch 批次须包含 1–12 个并发Work Order');
  const seen = new Set();
  const history = Object.keys(ledger);
  function claimId(id) {
    requireValue(typeof id === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(id), `Work Order ID 不合法：${id}`);
    const folded = id.toLowerCase();
    const conflict = history.find(key => key !== id && key.toLowerCase() === folded);
    requireValue(!conflict, `Work Order ID ${id} 与历史Work Order ${conflict} 仅大小写不同`);
    requireValue(!seen.has(folded), `同一Dispatch Batch内Work Order ID 重复（含 replaces，忽略大小写）：${id}`);
    seen.add(folded);
  }
  return rawJobs.map((job, idx) => {
    const jobId = String(job.id || `job-${idx + 1}`).trim();
    claimId(jobId);
    const current = Object.hasOwn(ledger, jobId) ? ledger[jobId] : null;
    requireValue(!['landed', 'verified', 'replaced'].includes(current?.status), `Work Order ${jobId} 已完成，不可重复派发`);
    const replaces = job.replaces ?? (current?.status === 'rejected' ? current.replaces : null);
    if (replaces) {
      claimId(replaces);
      requireValue(ledger[replaces]?.status === 'rejected' && (!current || current.replaces === replaces), `Work Order ${jobId} 的 replaces 须指向原被打回的Work Order：${replaces}`);
    }
    requireValue(TRADES.includes(job.trade), `Work Order ${jobId} 的工种须为 architect、builder 或 verifier`);
    requireValue(typeof job.title === 'string' && job.title.trim(), `Work Order ${jobId} 缺少 title`);
    requireValue(typeof job.task === 'string' && job.task.trim(), `Work Order ${jobId} 缺少 task`);

    const prev = current ?? (replaces ? ledger[replaces] : {});
    if (prev.status === 'rejected') {
      const previousId = current ? jobId : replaces;
      const retry = Object.values(ledger).find(entry => entry.status === 'rejected' && entry.replaces === previousId);
      if (retry) throw new Error(`Work Order ${previousId} 的最新打回记录在 ${retry.id}，请复用该 ID 或在 replaces 中指向它`);
    }
    requireValue(prev.status !== 'rejected' || (prev.trade === 'verifier') === (job.trade === 'verifier'), `Work Order ${jobId} 重试时不能在编码和验证工种间互换`);
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
      ...(job.trade === 'verifier' && prev.openMusts?.length ? { openMusts: prev.openMusts } : {}),
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
      resolved: [],
      error: 'Verifier未输出含布尔值 passed 的结构化 JSON 结论',
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
    resolved: Array.isArray(verdict.resolved) ? verdict.resolved.filter(id => typeof id === 'string' && id.trim()) : [],
    ...(passed ? {} : { error: summary || (hasMust ? '验证发现 must 缺陷' : '验证结论为未通过（passed=false）') }),
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
    Object.assign(entry, {
      session: w.session ?? null, exitCode: w.exitCode ?? null, signal: w.signal ?? null,
      failureKind: w.failureKind ?? null, lastAnswer: w.answer ?? w.summary ?? '',
      detail: w.detail ?? '', head: w.head ?? null,
    });
    entry.retainedRefs = [...new Set([
      ...entry.retainedRefs ?? [], entry.lastRejectedRef, ...w.retainedRefs ?? [], w.retainedRef,
    ].filter(Boolean))];
    const rejection = () => ({
      id: w.id, reason: entry.lastFeedback, rejections: entry.rejections, nextTier: entry.nextTier,
      session: entry.session, exitCode: entry.exitCode, signal: entry.signal, failureKind: entry.failureKind,
    });
    if (w.trade === 'verifier') {
      if (w.replaces && !entry.openMusts) {
        const original = ledger[w.replaces];
        entry.openMusts = original.openMusts;
        original.openMusts = [];
      }
      const resolved = w.status === 'rejected' ? w.resolved ?? [] : [];
      const unresolvedMusts = (entry.openMusts ?? []).filter(f => !resolved.includes(f.id));
      const claimed = new Set();
      const reportedMusts = [];
      for (const f of w.findings ?? []) {
        const finding = { ...f, sourceJob: w.id, verifier: w.agentSummary };
        if (finding.level === 'must') {
          finding.title ||= finding.detail || '未命名的must缺陷';
          finding.location = typeof finding.location === 'string' ? finding.location.trim() : '';
          const hasId = typeof finding.id === 'string' && finding.id.trim() !== '';
          let must = unresolvedMusts.find(item => !claimed.has(item.id) && (hasId
            ? item.id === finding.id
            : item.title === finding.title && (item.detail ?? '') === (finding.detail ?? '')
              && (item.location ?? '') === finding.location));
          if (must) {
            claimed.add(must.id);
          } else {
            entry.mustCount = (entry.mustCount ?? 0) + 1;
            must = { id: `${w.id}#${entry.mustCount}`, title: finding.title, detail: finding.detail };
          }
          must.location = finding.location || must.location || '';
          finding.id = must.id;
          reportedMusts.push(must);
        }
        findings.push(finding);
      }
      if (w.status === 'succeeded' && w.passed === true && !reportedMusts.length) {
        entry.openMusts = [];
        entry.status = 'verified';
        entry.tier = w.tier;
        entry.agentSummary = w.agentSummary;
        entry.lastAnswer = w.summary ?? '';
        entry.lastFeedback = '';
      } else {
        entry.openMusts = [...reportedMusts, ...unresolvedMusts.filter(f => !claimed.has(f.id))];
        entry.rejections = (entry.rejections ?? 0) + 1;
        entry.status = 'rejected';
        entry.lastFeedback = w.error || w.summary || '验证Work Order未通过或结论缺失';
        const next = resolveEngineer('verifier', { difficulty: w.difficulty, rejections: entry.rejections }, settings);
        entry.nextTier = next.tier;
        rejected.push(rejection());
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
      rejected.push(rejection());
      continue;
    }

    const isFastForward = tip === baseTip
      && spawnSync('git', ['-C', cwd, 'merge-base', '--is-ancestor', baseTip, w.head]).status === 0;
    if (isFastForward) {
      tip = w.head;
      entry.status = 'landed';
      entry.lastFeedback = '';
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
      entry.lastFeedback = '';
      entry.commit = tip;
      entry.tier = w.tier;
      entry.agentSummary = w.agentSummary;
      ledger[w.id] = entry;
      landed.push({ id: w.id, commit: tip, trade: w.trade, tier: w.tier });
    } else {
      const conflictFiles = merged.stdout.split('\0').slice(1).filter(Boolean);
      entry.rejections = (entry.rejections ?? 0) + 1;
      entry.status = 'rejected';
      entry.failureKind = 'gate_rejected';
      entry.lastRejectedHead = w.head;
      entry.lastFeedback = `并发合入冲突（冲突文件：${conflictFiles.join('、') || '未知'}），请在最新Requirement Branch上复用前序提交并解决冲突`;
      const next = resolveEngineer(w.trade, { difficulty: w.difficulty, rejections: entry.rejections }, settings);
      entry.nextTier = next.tier;
      ledger[w.id] = entry;
      rejected.push(rejection());
    }
  }

  for (const { id } of workerResults) {
    const entry = ledger[id];
    if (!['landed', 'verified'].includes(entry.status)) continue;
    let replaced = entry.replaces;
    while (replaced && ledger[replaced]?.status === 'rejected') {
      const original = ledger[replaced];
      original.status = 'replaced';
      original.replacedBy = id;
      if (original.trade === 'verifier') original.openMusts = [];
      replaced = original.replaces;
    }
  }
  return { tip, changed: tip !== baseTip, landed, rejected, findings, ledger };
}

export function evaluateVerificationGate({ head, verifyCommit, verifyPassed, verifyReport = '', review = null }) {
  if (!verifyPassed || verifyCommit !== head) {
    const detail = verifyCommit && verifyCommit !== head
      ? `Dual-Track Verification提交（${verifyCommit}）与当前交付 HEAD（${head}）不一致，需重新验证。\n${verifyReport}`
      : verifyReport;
    const extraReview = review && review.head === head && review.decision === 'REQUEST_CHANGES'
      ? `\n\n### Independent Code Review（Verifier）结论：REQUEST_CHANGES\n${review.line ?? ''}\n${review.report ?? ''}`
      : '';
    return {
      route: 'lead',
      reason: `### Dual-Track Verification未通过\n${detail}${extraReview}`,
    };
  }

  const verdict = reviewVerdict(head, review);
  return verdict.route === 'changes' ? { ...verdict, route: 'lead' } : verdict;
}

function dualReport(state) {
  const sections = [state.verifyReport];
  for (const [label, raw] of [['Dual-Track Verification 发现', state.verifyFindings], ['实证证据', state.verifyEvidence]]) {
    if (!raw) continue;
    const items = jsonList(raw);
    const detail = items ? items.map(item => `- ${typeof item === 'string' ? item : JSON.stringify(item)}`).join('\n') : raw;
    sections.push(`**${label}**\n${detail || '无'}`);
  }
  return sections.filter(Boolean).join('\n\n');
}

const findingTitle = ({ title, location }) => `${title ?? ''}${location ? `（${location}）` : ''}`;

const ignoredLines = items => items.map((item, index) =>
  `- ${[item.id, item.title].filter(Boolean).join(' ') || `审查意见 ${index + 1}`}：${item.reason}`
).join('\n');

export function buildPrSummary(state) {
  const landedLines = Object.values(state.ledger ?? {})
    .filter(item => item.status === 'landed')
    .map(item => `- [${item.trade}/${item.tier}] ${item.id} · ${item.title}（${item.agentSummary ?? ''}）`);
  const rebutted = requestedChanges(state, state.head) && state.rebuttedReviewHead === state.head;
  const review = state.review?.head === state.head
    ? `**Verifier 原审查结论：${state.review.decision}**\n${state.review.line ?? ''}\n${state.review.report ?? ''}` : '';
  const dual = dualReport(state);
  const archivePaths = state.archivePaths ?? [state.archivePath].filter(Boolean);

  return [
    rebutted ? `### 需用户最终裁决：Lead建议在 Verifier 要求修改的情况下交付\n${review}\n\n#### Lead逐条不采纳依据\n${ignoredLines(state.reviewRebuttals)}` : '',
    state.report || `需求：${state.title}`,
    `### 五层交付证据（提交 \`${state.head}\`）`,
    `#### 项目检查（L2）\n${checkRunsText(state.checks, state.head)}`,
    dual ? `#### Outcome-Oriented Verification · Dual-Track Verification（L3）\n${dual}` : '',
    review && !rebutted ? `#### Independent Code Review（Verifier）\n${review}` : '',
    landedLines.length ? `#### 已合入Work Order\n${landedLines.join('\n')}` : '',
    state.ignoredFindings?.length ? `#### Lead裁定忽略的非阻塞项及依据\n${ignoredLines(state.ignoredFindings)}` : '',
    `#### Investigation Archive\n${state.archived && archivePaths.length ? `已持久化（待后续 \`dickda-refine\` Refine）：\n${archivePaths.map(path => `- \`${path}\``).join('\n')}` : '本次未新增 Investigation Archive'}`,
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

const planPath = '.dickda/tasks/PLAN_5L.md';

function validateThought(root, thinkBase, call) {
  requireValue(call.status === 0 && call.head, `Thinker会话未成功产出Five-Layer Plan提交：${agentFailure(call)}`);
  const head = git('rev-parse', '--verify', `${call.head}^{commit}`);
  requireValue(head !== thinkBase && isAncestor(thinkBase, head), `Thinker返回的提交（${head}）不是当前Requirement Branch基线（${thinkBase}）的严格后代`);
  const outsidePlan = execFileSync('git', ['diff', '--name-only', '-z', '--no-renames', thinkBase, head, '--'], { cwd: root, encoding: 'utf8' })
    .split('\0').filter(path => path && path !== planPath);
  requireValue(!outsidePlan.length, `Thinker只可修改 ${planPath}，提交还改动了：${outsidePlan.join('、')}`);
  const preview = planPreview(git('show', `${head}:${planPath}`));
  requireValue(preview, 'Thinker提交的 PLAN_5L.md 须含 L1–L5 各层方案正文');
  return { head, preview, answer: call.answer };
}

async function heavyThink({ root, state, settings, head, env, persistentDir }) {
  const planRound = state.planRound ?? 1;
  const local = runtime(root, `heavy-think/${env.GITHUB_RUN_ID}/round-${planRound}`);
  const durable = persistentDir ? join(persistentDir, 'heavy-think', `round-${planRound}`) : local;
  const read = name => existsSync(join(durable, name)) ? readFileSync(join(durable, name), 'utf8') : '';
  const write = (name, text) => {
    atomic(join(durable, name), text, 0o600);
    if (durable !== local) atomic(join(local, name), text, 0o600);
  };
  const writeJson = (name, value) => write(name, JSON.stringify(value, null, 2) + '\n');
  const freeze = (thinkBase, planFeedback) => {
    git('checkout', '--detach', thinkBase);
    return {
      version: 1, runId: env.GITHUB_RUN_ID, planRound, previousPlanRound: planRound > 1 ? planRound - 1 : null,
      thinkBase, title: state.title, goal: state.goal, planFeedback,
      task: readFileSync(managed(root, 'tasks/TODO_TASK.md'), 'utf8'),
      project: readFileSync(managed(root, 'project.json'), 'utf8'),
      projectDoc: readFileSync(managed(root, 'project.md'), 'utf8'),
      guidelines: enabledGuidelinesDigest(root),
      previousPlan: readFileSync(managed(root, 'tasks/PLAN_5L.md'), 'utf8'),
      instructions: rolePrompt('thinker'),
      agents: { Coordinator: settings.thinkerCoordinator, Carbon: settings.thinkerCarbon, Astra: settings.thinkerAstra },
    };
  };
  let manifest = JSON.parse(read('manifest.json') || 'null');
  const previous = JSON.parse(read('context.json') || 'null');
  let context;
  // A completed retry reads the original frozen base, not its own newly published plan.
  if (manifest?.final?.head === head && previous?.planRound === planRound
    && (!state.planFeedback || state.planFeedback === previous.planFeedback)) {
    const candidate = freeze(previous.thinkBase, previous.planFeedback);
    if (hash(JSON.stringify(candidate)) === manifest.fingerprint) context = candidate;
  }
  context ??= freeze(head, state.planFeedback || '');
  const fingerprint = hash(JSON.stringify(context));
  if (manifest?.fingerprint !== fingerprint) manifest = { fingerprint, thinkBase: context.thinkBase, stages: {} };
  const saveManifest = () => writeJson('manifest.json', manifest);
  writeJson('context.json', context);
  saveManifest();
  const thinkBase = context.thinkBase;
  const frozen = `## Frozen Context\n${JSON.stringify(context, null, 2)}`;
  const controller = new AbortController();
  const revisionValid = body => Boolean(body.match(/^## Review Decisions[ \t]*\r?\n([\s\S]*)/m)?.[1].split(/^#{1,6}[ \t]/m)[0].trim());
  const valid = (body, kind) => Boolean(body.trim()) && (kind === 'review' || Boolean(planPreview(body)))
    && (kind !== 'revised' || revisionValid(body));

  async function produce(stage, role, file, instruction, kind) {
    const prompt = `# Heavy Mode · Stage ${stage} · ${role}\n\n${frozen}\n\n${instruction}\n\n只在当前独立会话中工作。用 Markdown 回复本阶段产物，不推送、不开 PR、不派单，不读取其他会话或 Heavy Mode 私有运行目录。`;
    const inputHash = hash(prompt);
    const cached = manifest.stages[file];
    const body = read(file);
    if (cached?.inputHash === inputHash && cached.bodyHash === hash(body) && valid(body, kind)) {
      write(file, body);
      return body;
    }
    delete manifest.final;
    const promptFile = join(local, `${file}.prompt.md`);
    write(`${file}.prompt.md`, prompt);
    let call;
    const attempts = [];
    try {
      call = await callCodaAgentAsync(['--commit', thinkBase, '--title', `Heavy Mode · Stage ${stage} · ${role}：${state.title}`,
        ...agentArgs(context.agents[role]), '--json', '--prompt-file', promptFile], root, { signal: controller.signal });
      for (let retry = 0; ; retry++) {
        attempts.push(agentResult(call));
        requireValue(call.status === 0 && !call.failureKind, agentFailure(call));
        let output = call.answer;
        // Some planners commit their plan in their own session instead of quoting it in the answer.
        if (kind !== 'review' && !planPreview(output) && call.head && call.head !== thinkBase && isAncestor(thinkBase, call.head)
          && git('diff', '--name-only', thinkBase, call.head, '--', planPath)) {
          const committed = spawnSync('git', ['show', `${call.head}:${planPath}`], { cwd: root, encoding: 'utf8' });
          if (committed.status === 0) output += `\n\n${committed.stdout}`;
        }
        if (valid(output, kind)) {
          write(file, output);
          manifest.stages[file] = { inputHash, bodyHash: hash(output), attempts };
          saveManifest();
          return output;
        }
        requireValue(kind !== 'review' && retry === 0 && call.session,
          kind === 'review' ? 'Review 须为非空文本' : '须含 L1–L5 各层方案正文；修订稿还须含非空 Review Decisions');
        write(`${file}.prompt.md`, `${prompt}\n\n## Format Completion (1/1)\n上一回复格式不完整。请直接回复完整 L1–L5 五层非空方案正文；修订稿还须在 ## Review Decisions 下逐条说明采纳/不采纳及客观依据。\n`);
        const session = call.session;
        call = await callCodaAgentAsync(['--continue', session, '--json', '--prompt-file', promptFile], root, { signal: controller.signal });
        call.session ||= session;
      }
    } catch (error) {
      const failure = { ...agentResult(call), failureKind: call?.failureKind || 'invalid_output', detail: error.message };
      if (!controller.signal.aborted) {
        manifest.failure = { stage, role, ...failure, attempts };
        saveManifest();
      }
      controller.abort();
      throw new Error(`Heavy Mode · Stage ${stage} · ${role}：${error.message}\n${agentFailure({ ...call, ...failure })}`);
    }
  }

  async function pair(tasks) {
    try { return await Promise.all(tasks); }
    catch (error) {
      controller.abort();
      await Promise.allSettled(tasks);
      throw error;
    }
  }
  const draft = '独立制定完整 Markdown Five-Layer Plan，包含 L1–L5 各层非空正文。本阶段不可读取对方初稿；旧 PLAN_5L.md 仅为背景，按当前需求和最新 planFeedback 重新规划。';
  const [carbonDraft, astraDraft] = await pair([
    produce(1, 'Carbon', 'carbon-draft.md', draft, 'draft'),
    produce(1, 'Astra', 'astra-draft.md', draft, 'draft'),
  ]);
  const review = (author, body) => `审阅 ${author} 初稿，从五层契约完整性、架构边界、并发/状态风险、验证覆盖度逐条给出具体 Review 意见与修改建议。\n\n## ${author} Draft\n${body}`;
  const [carbonReview, astraReview] = await pair([
    produce(2, 'Carbon', 'carbon-review-astra.md', review('Astra', astraDraft), 'review'),
    produce(2, 'Astra', 'astra-review-carbon.md', review('Carbon', carbonDraft), 'review'),
  ]);
  const revise = (own, reviewer, body) => `根据对方 Review 修订自己的方案。先在 ## Review Decisions 下逐条说明采纳/不采纳及客观依据，再输出完整 L1–L5 Five-Layer Plan。\n\n## Own Draft\n${own}\n\n## Review from ${reviewer}\n${body}`;
  const [carbonRevised, astraRevised] = await pair([
    produce(3, 'Carbon', 'carbon-revised.md', revise(carbonDraft, 'Astra', astraReview), 'revised'),
    produce(3, 'Astra', 'astra-revised.md', revise(astraDraft, 'Carbon', carbonReview), 'revised'),
  ]);
  const promptFile = join(local, 'coordinator.prompt.md');
  write('coordinator.prompt.md', [
    '# Heavy Mode · Stage 4 · Coordinator', frozen,
    `## Carbon Draft\n${carbonDraft}`, `## Astra Draft\n${astraDraft}`,
    `## Carbon Review of Astra\n${carbonReview}`, `## Astra Review of Carbon\n${astraReview}`,
    `## Carbon Revised Plan and Review Decisions\n${carbonRevised}`, `## Astra Revised Plan and Review Decisions\n${astraRevised}`,
    `综合双方优势，逐条裁决分歧并说明依据，将最终完整 Five-Layer Plan 写入 ${planPath} 并提交为 ${thinkBase} 的严格后代。只可修改该文件，不写入任何中间产物。确认本会话后台检查已完成再汇报提交 SHA。不要推送、开 PR 或派单。`,
  ].join('\n\n'));
  let call = manifest.final;
  try {
    if (!call || spawnSync('git', ['cat-file', '-e', `${call.head}^{commit}`]).status !== 0) {
      const args = call?.session ? ['--continue', call.session] : ['--commit', thinkBase, '--title', `Heavy Mode · Stage 4 · Coordinator：${state.title}`, ...agentArgs(settings.thinkerCoordinator)];
      call = await callDeliveryAgentAsync([...args, '--json', '--prompt-file', promptFile], { cwd: root, baseHead: thinkBase, promptFile, signal: controller.signal });
    }
    const result = validateThought(root, thinkBase, call);
    manifest.final = { ...call, head: result.head };
    delete manifest.failure;
    saveManifest();
    return result;
  } catch (error) {
    manifest.failure = { stage: 4, role: 'Coordinator', ...agentResult(call), failureKind: call.failureKind || 'gate_rejected', detail: error.message };
    saveManifest();
    throw new Error(`Heavy Mode · Stage 4 · Coordinator：${error.message}\n${agentFailure(call)}`);
  }
}

function recordInvestigationLogs(root, baseTip, results, ledger, runId, round) {
  const substantive = body => body.replaceAll(INVESTIGATE_MARKER.trim(), '').replace(/<!--[\s\S]*?-->/g, '').split('\n')
    .some(line => line.trim() && !/^\s*(?:#{1,6}\s|(?:[-*]\s*)?(?:TODO|TBD|待填写|占位)\s*$)/i.test(line));
  for (const result of results) {
    const safeJobId = result.id.replace(/[^a-z0-9_-]/gi, '_');
    const path = `.dickda/tasks/logs/${safeJobId}.md`;
    const file = managed(root, `tasks/logs/${safeJobId}.md`);
    const body = existsSync(file) ? readFileSync(file, 'utf8') : '';
    const entry = ledger[result.id];
    const hasCommit = result.head && spawnSync('git', ['cat-file', '-e', `${result.head}^{commit}`]).status === 0;
    const marker = `<!-- dickda-execution ${JSON.stringify({ runId, round, session: result.session ?? null, head: result.head ?? result.baseHead ?? baseTip })} -->`;
    if (body.split('\n').includes(marker)) continue;
    // Only this worker's own committed log can replace the fallback for this execution.
    if (entry.status === 'landed' && hasCommit && git('ls-tree', '--name-only', result.head, '--', path)
      && substantive(git('show', `${result.head}:${path}`))
      && git('diff', '--name-only', result.baseHead ?? baseTip, result.head, '--', path)) continue;
    const diff = hasCommit ? git('diff', '--stat', result.baseHead ?? baseTip, result.head) : '无有效代码提交（Verifier Work Order或未交付）';
    const section = [
      marker,
      `## Execution · ${runId} · round ${round}`,
      `- Run ID：${runId}\n- Work Order：${result.id}\n- 工种/级别：${result.trade}/${result.tier}\n- 标题：${result.title}\n- Session：${result.session ?? '未返回'}\n- Base：${result.baseHead ?? baseTip}\n- Commit：${result.head ?? '无'}\n- 集成状态：${entry.status}\n- exitCode：${result.exitCode ?? '未知'}\n- signal：${result.signal ?? 'none'}\n- failureKind：${entry.failureKind ?? 'none'}`,
      `### Diff 统计\n${diff || '无文件变化'}`,
      `### 验证结论\n${result.summary || result.error || result.answer || '编码提交通过 Spec Lock 与 L2 Lint 门禁'}${entry.lastFeedback ? `\n${entry.lastFeedback}` : ''}`,
      `### Findings\n${JSON.stringify(result.findings ?? [], null, 2)}`,
    ].join('\n\n');
    atomic(file, `${substantive(body) ? body.trim() : `# Investigation · ${result.id}`}\n\n${section}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const env = process.env;
    const action = process.argv[2];
    if (action === 'lane') requireValue(!(env.FAST === 'true' && env.HEAVY_THINK === 'true'), 'Fast Mode 与 Heavy Mode 互斥');
    let repoInfo;
    const getRepoInfo = () => repoInfo ??= JSON.parse(gh('repo', 'view', '--json', 'nameWithOwner,defaultBranchRef'));
    const persistentFile = env.CODA_PLUGIN_STATE ? join(env.CODA_PLUGIN_STATE, 'runs',
      projectGroup(repo(), `https://github.com/${getRepoInfo().nameWithOwner}.git`).replace(/^dickda:/, ''),
      env.GITHUB_RUN_ID, 'develop.json') : null;
    const persistentDir = persistentFile ? dirname(persistentFile) : null;
    const runDir = persistentDir ?? env.CODA_ARTIFACTS;
    const readRunJson = name => JSON.parse(readFileSync(join(runDir, name), 'utf8'));
    const saveRunJson = (name, value) => {
      if (persistentDir) save(join(persistentDir, name), value);
      save(join(env.CODA_ARTIFACTS, name), value);
    };
    const saveState = next => saveRunJson('develop.json', next);
    // Artifacts are only a mirror. A stopped dual write may leave an older, still valid JSON file there.
    if (persistentDir && existsSync(persistentDir)) {
      for (const folder of ['', 'jobs', 'workers']) {
        const source = join(persistentDir, folder);
        if (!existsSync(source)) continue;
        for (const name of readdirSync(source).filter(name => name.endsWith('.json'))) {
          const target = join(env.CODA_ARTIFACTS, folder, name);
          save(target, JSON.parse(readFileSync(join(source, name), 'utf8')));
        }
      }
    }
    let state = existsSync(join(runDir, 'develop.json')) ? readRunJson('develop.json') : null;
    const settings = effectiveSettings(env);

    const jobRefPrefix = id => `refs/heads/dickda/job-${env.GITHUB_RUN_ID}-${state.round}-${id}-`;
    const recoverWorker = (job, result) => {
      if (job.trade === 'verifier' || (result && !result.publication)) return result;
      const baseHead = result?.baseHead ?? job.baseHead ?? state.lastLeadHead;
      const ref = result?.jobRef ? `refs/heads/${result.jobRef}` : result?.retainedRef;
      const legacyRef = `refs/heads/dickda/job-${env.GITHUB_RUN_ID}-${job.id}`;
      const remote = remoteGit('.', 'ls-remote', '--heads', state.remote, ...(ref ? [ref] : [`${jobRefPrefix(job.id)}*`, legacyRef]));
      const reachable = [];
      for (const line of remote.split('\n').filter(Boolean)) {
        const [head, candidate] = line.split('\t');
        if (!ref && candidate !== legacyRef && candidate !== `${jobRefPrefix(job.id)}${head}`) continue;
        fetchHead(state.remote, candidate.slice('refs/heads/'.length));
        if (ref) requireValue(head === result.head, `Work Order ${job.id} 的远端引用 ${ref} 已改变，拒绝替换持久化交付 ${result.head}`);
        if (head !== baseHead && isAncestor(baseHead, head)) reachable.push({ head, ref: candidate });
      }
      if (!reachable.length) {
        if (!result) return result;
        return { ...result, status: 'failed', jobRef: null, retainedRef: null,
          failureKind: 'agent_error', error: result.error || 'Work Order交付引用尚未发布，请重试。' };
      }
      let recovered;
      if (result) {
        const { publication, ...delivery } = result;
        recovered = { ...delivery, status: publication.resultStatus,
          failureKind: publication.failureKind, error: publication.error };
      } else {
        const latest = reachable.at(-1);
        recovered = {
          ...job, runId: env.GITHUB_RUN_ID, round: state.round, baseHead,
          head: latest.head, retainedRef: latest.ref, retainedRefs: reachable.map(item => item.ref),
          status: 'rejected', session: null, exitCode: null, failureKind: 'invalid_output',
          error: '已恢复远端交付，但缺少 Worker 终态门禁记录；请复用此提交完成核验。',
        };
      }
      saveRunJson(`workers/${state.round}-${job.id}.json`, recovered);
      return recovered;
    };

    const settleBatch = (recover = false) => {
      const batch = readRunJson(`batch-${state.round}.json`);
      const workersDir = join(runDir, 'workers');
      const prefix = `${state.round}-`;
      const files = existsSync(workersDir)
        ? readdirSync(workersDir).filter(f => f.startsWith(prefix) && f.endsWith('.json')).sort()
        : [];
      const results = files.map(file => {
        const result = JSON.parse(readFileSync(join(workersDir, file), 'utf8'));
        requireValue(file === `${prefix}${result.id}.json`, `Work Order结果文件 ${file} 与其中的 ID ${result.id} 不一致`);
        return result;
      });
      const expected = batch.map(job => job.id).sort();
      // A delivery push and ledger update can succeed before a temporary ref deletion needs retrying.
      if (state.integration?.round === state.round) {
        deleteRefs(state.remote, state.integration.cleanup);
        return { head: state.head, changed: state.integration.changed };
      }
      const root = repo();
      const baseTip = fetchHead(state.remote, state.reqBranch);
      git('checkout', '--detach', baseTip);

      for (const job of batch) {
        const index = results.findIndex(result => result.id === job.id);
        const result = recoverWorker(job, results[index]);
        if (result) {
          if (index === -1) results.push(result);
          else results[index] = result;
        }
      }
      const received = results.map(result => result.id).sort();
      requireValue((recover || expected.length === received.length) && received.every(id => expected.includes(id)),
        `第 ${state.round} 轮派单与回收的Work Order ID 不一致：派发 [${expected.join(', ')}]，回收 [${received.join(', ')}]`);

      for (const r of results) {
        const ref = r.jobRef || r.retainedRef;
        if (ref) {
          const head = fetchHead(state.remote, ref.replace(/^refs\/heads\//, ''));
          requireValue(head === r.head, `Work Order ${r.id} 的远端引用 ${ref} 已改变，拒绝替换持久化交付 ${r.head}`);
        }
      }

      const merged = integrateWorkerResults(root, baseTip, results, state.ledger ?? {}, settings);
      for (const job of batch.filter(job => !received.includes(job.id))) {
        merged.ledger[job.id] = {
          ...job, ...(job.previousHead ? { lastRejectedHead: job.previousHead, lastRejectedRef: job.previousRef } : {}),
          ...merged.ledger[job.id], status: 'pending',
          lastFeedback: '本轮中断前未回收到 Worker 结果，请在最新 Requirement Branch 上继续此 Work Order。',
        };
      }
      for (const r of results) {
        if (r.jobRef && merged.ledger[r.id].status === 'rejected') {
          merged.ledger[r.id].lastRejectedRef = `refs/heads/${r.jobRef}`;
        }
      }
      git('checkout', '--detach', merged.tip);
      recordInvestigationLogs(root, baseTip, results, merged.ledger, env.GITHUB_RUN_ID, state.round);
      git('add', '.dickda/tasks/logs');
      if (git('diff', '--cached', '--name-only')) {
        git('commit', '-m', `chore(dickda): record investigation for batch ${state.round}`);
        merged.tip = git('rev-parse', 'HEAD');
        merged.changed = true;
      }
      if (merged.changed) {
        remoteGit('.', 'push', '--quiet', '--no-follow-tags', state.remote, `${merged.tip}:refs/heads/${state.reqBranch}`);
      }
      const cleanup = [...new Set([...releasePreviousRefs(merged.ledger), ...results
        .filter(r => r.jobRef && merged.ledger[r.id].status === 'landed').map(r => `refs/heads/${r.jobRef}`)])];

      const feedbackParts = [];
      if (merged.landed.length) feedbackParts.push(`已合入Work Order：${merged.landed.map(l => `${l.id}(${l.trade}/${l.tier})`).join('、')}`);
      if (merged.rejected.length) feedbackParts.push(`未通过Work Order：\n${merged.rejected.map(r => `- ${r.id}（累计未通过 ${r.rejections} 次${r.nextTier === 'senior' ? '，下次派单自动升级 senior' : ''}）：session=${r.session}, exitCode=${r.exitCode}, signal=${r.signal}, failureKind=${r.failureKind}\n${r.reason}`).join('\n')}`);
      const findings = [
        ...Object.values(merged.ledger).flatMap(job => job.openMusts ?? []),
        ...merged.findings.filter(f => f.level !== 'must'),
      ];
      if (findings.length) feedbackParts.push(`Verifier报告的问题：\n${findings.map((f, idx) => `- ${f.id ?? `#${idx + 1}`} [${f.level ?? 'must'}] ${findingTitle(f)}：${f.detail ?? ''}`).join('\n')}`);

      state = {
        ...state,
        head: merged.tip,
        ledger: merged.ledger,
        pendingJobs: [],
        integration: { round: state.round, changed: merged.changed, cleanup },
        pendingFeedback: [state.pendingFeedback, ...feedbackParts].filter(Boolean).join('\n\n'),
      };
      saveState(state);
      deleteRefs(state.remote, cleanup);
      return { head: merged.tip, changed: merged.changed };
    };

    switch (action) {
      case 'lane': {
        if (state) {
          state.head = fetchHead(state.remote, state.reqBranch);
          if (env.HEAVY_THINK !== undefined) state.heavyThink = env.HEAVY_THINK === 'true';
          saveState(state);
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
        const repoInfo = getRepoInfo();
        const defaultBranch = repoInfo.defaultBranchRef.name;
        const base = (env.BASE || '').trim() || defaultBranch;
        requireValue(base === defaultBranch, `仅允许以仓库Default Branch ${defaultBranch} 作为目标分支，当前指定的是 ${base}`);
        const remote = `https://github.com/${repoInfo.nameWithOwner}.git`;
        const baseCommit = fetchHead(remote, base);

        let startCommit = baseCommit;
        const reqBranch = `dickda/req-${env.GITHUB_RUN_ID}`;
        const existing = remoteGit('.', 'ls-remote', '--heads', remote, `refs/heads/${reqBranch}`);
        if (existing) {
          startCommit = fetchHead(remote, reqBranch);
          requireValue(isAncestor(baseCommit, startCommit), `已有Requirement Branch ${reqBranch} 不是基线 ${baseCommit} 的后代，拒绝覆盖`);
        } else {
          const branch = env.BRANCH?.trim();
          if (branch) {
            const local = spawnSync('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`], { encoding: 'utf8' });
            if (local.status === 0) startCommit = local.stdout.trim();
            else if (branch !== base) startCommit = fetchHead(remote, branch);
          }
          remoteGit('.', 'push', '--quiet', '--no-follow-tags', remote, `${startCommit}:refs/heads/${reqBranch}`);
        }

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
        const group = projectGroup(root, remote);
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
          planRound: 1,
          heavyThink: env.HEAVY_THINK === 'true',
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
        git('checkout', '--detach', head);
        if (state.confirmedPlanHead) {
          requireValue(isAncestor(state.confirmedPlanHead, head), `Requirement Branch ${head} 不包含已确认方案 ${state.confirmedPlanHead}，拒绝重新初始化`);
          saveState({ ...state, head });
          appendGithubOutput({ head, alreadyConfirmed: true, hasPlan: true, preview: planPreview(readFileSync(managed(root, 'tasks/PLAN_5L.md'), 'utf8')) });
          break;
        }
        init(root);
        const todo = managed(root, 'tasks/TODO_TASK.md');
        const plan = managed(root, 'tasks/PLAN_5L.md');
        const original = readFileSync(todo, 'utf8').trim().replaceAll('\r\n', '\n');
        const task = existingTask(original);
        const goal = state.goal.replaceAll('\r\n', '\n');
        const sameGoal = task && (goal === task.goal || goal === original);
        const goalChanged = state.briefProvided && !sameGoal;
        if (!task || goalChanged) atomic(todo, `# ${state.title}\n\n${state.goal}\n`);
        if (goalChanged && !state.heavyThink) atomic(plan, DEFAULT_PLAN);
        const preview = planPreview(readFileSync(plan, 'utf8'));
        git('add', '.dickda');
        if (git('status', '--porcelain', '--', '.dickda')) {
          git('commit', '-m', `chore(dickda): initialize .dickda assets for ${state.title}`);
          head = git('rev-parse', 'HEAD');
          remoteGit('.', 'push', '--quiet', '--no-follow-tags', state.remote, `${head}:refs/heads/${state.reqBranch}`);
        }
        saveState({ ...state, head });
        appendGithubOutput({ head, alreadyConfirmed: false, hasPlan: Boolean(preview), preview });
        break;
      }

      case 'think': {
        const root = repo();
        const thinkBase = fetchHead(state.remote, state.reqBranch);
        git('checkout', '--detach', thinkBase);
        state.planRound ??= 1;
        state.heavyThink = env.HEAVY_THINK === 'true';
        saveState(state);
        let thought;
        if (state.heavyThink) {
          thought = await heavyThink({ root, state, settings, head: thinkBase, env, persistentDir });
        } else {
          const promptFile = join(env.RUNNER_TEMP, 'thinker.md');
          const prompt = [
            rolePrompt('thinker'),
            `## 当前项目已启用规范摘要\n${enabledGuidelinesDigest(root)}`,
            `## 本次需求原文（.dickda/tasks/TODO_TASK.md）\n${readFileSync(managed(root, 'tasks/TODO_TASK.md'), 'utf8')}`,
            `## Plan Round\n${state.planRound}`,
            state.planFeedback ? `## Interactor/用户修订意见\n${state.planFeedback}` : '',
            `请将完整的Five-Layer Plan写入 \`${planPath}\`，只提交这一份文件到当前分支（不要推送或开 PR），最后简要汇报五层核心设计。`,
          ].filter(Boolean).join('\n\n');
          writeFileSync(promptFile, prompt);
          const call = callDeliveryAgent([
            '--commit', thinkBase, '--title', `Thinker规划：${state.title}`,
            ...agentArgs(settings.thinker), '--json', '--prompt-file', promptFile,
          ], { cwd: root, baseHead: thinkBase, promptFile });
          thought = validateThought(root, thinkBase, call);
        }
        if (thought.head !== thinkBase) remoteGit('.', 'push', '--quiet', '--no-follow-tags', state.remote, `${thought.head}:refs/heads/${state.reqBranch}`);
        saveState({ ...state, head: thought.head, planAnswer: thought.answer, planFeedback: '' });
        appendGithubOutput({ head: thought.head, preview: thought.preview });
        break;
      }

      case 'plan-feedback': {
        const planFeedback = env.FEEDBACK?.trim();
        requireValue(planFeedback, '退回Thinker时须填写方案修订意见');
        saveState({ ...state, planFeedback, planRound: (state.planRound ?? 1) + 1 });
        break;
      }

      case 'lead-plan': {
        const root = repo();
        let fetchedHead = fetchHead(state.remote, state.reqBranch);
        const round = (state.round ?? 0) + 1;
        if (state.confirmedPlanHead) {
          requireValue(isAncestor(state.confirmedPlanHead, fetchedHead), `Requirement Branch ${fetchedHead} 不包含已确认方案 ${state.confirmedPlanHead}`);
        } else if (round === 1) {
          const approvedPlanHead = env.FAST === 'true' ? env.SEED_HEAD : env.APPROVED_HEAD;
          requireValue(fetchedHead === approvedPlanHead, `开工基线提交不一致：预期 ${approvedPlanHead || '缺失'}，Requirement Branch ${state.reqBranch} 当前为 ${fetchedHead}`);
          state.approvedPlanHead = approvedPlanHead;
          state.confirmedPlanHead = approvedPlanHead;
        }
        if (state.pendingJobs?.length) {
          settleBatch(true);
          fetchedHead = state.head;
        }
        state.head = fetchedHead;
        saveState(state);
        git('checkout', '--detach', fetchedHead);
        const planBody = existsSync(managed(root, 'tasks/PLAN_5L.md')) ? readFileSync(managed(root, 'tasks/PLAN_5L.md'), 'utf8') : '';
        const ledgerSummary = Object.values(state.ledger ?? {}).map(item => [
          `- ${item.id} [${item.trade}] status=${item.status}, rejections=${item.rejections ?? 0}`,
          item.replaces && `replaces=${item.replaces}`, item.replacedBy && `replacedBy=${item.replacedBy}`,
          item.status === 'rejected' && item.nextTier === 'senior' && '下次派单自动升级 senior',
          item.status === 'rejected' && item.lastFeedback,
          JSON.stringify(item),
          ...(item.openMusts ?? []).map(f => `\n  - ${f.id} ${findingTitle(f)}`),
        ].filter(Boolean).join(' ')).join('\n') || '尚无Work Order记录。';

        const promptFile = join(env.RUNNER_TEMP, `lead-${round}.md`);
        const last = state.lastLeadHead;
        const sync = state.leadSession && [
          `## 续跑代码视图\n如需查阅最新代码或规约，先执行：\ngit fetch ${state.remote} ${state.reqBranch} && git checkout --detach ${fetchedHead}`,
          last ? `从 ${last} 到 ${fetchedHead} 的新增提交：\n${git('log', '--oneline', '--no-decorate', `${last}..${fetchedHead}`) || '无'}\n\ngit diff --stat：\n${git('diff', '--stat', last, fetchedHead) || '无变化'}` : '',
        ].filter(Boolean).join('\n\n');
        const initialContext = () => [rolePrompt('lead'), `## 需求原文\n${state.goal}`, `## Five-Layer Plan（PLAN_5L.md）\n${planBody}`,
          `## 已合入提交历史（${state.baseCommit}..${fetchedHead}）\n${git('log', '--oneline', '--no-decorate', `${state.baseCommit}..${fetchedHead}`) || '无'}`,
        ].join('\n\n');
        const prompt = [
          sync || initialContext(),
          `## 第 ${round} 轮Lead决策上下文`,
          `- Requirement Branch：\`${state.reqBranch}\`，当前 HEAD：\`${fetchedHead}\``,
          `- 自动Escalation Threshold：Standard Engineer连续被打回 >= ${settings.escalationThreshold} 次自动升级Senior Engineer`,
          `- 可用工种级别：\n  - architect：Standard ${formatAgent(settings.architect.standard)} ｜ Senior ${formatAgent(settings.architect.senior)}\n  - builder：Standard ${formatAgent(settings.builder.standard)} ｜ Senior ${formatAgent(settings.builder.senior)}\n  - verifier：Standard ${formatAgent(settings.verifier.standard)} ｜ Senior ${formatAgent(settings.verifier.senior)}`,
          `## Work Order Ledger状态\n${ledgerSummary}`,
          state.pendingJobs?.length ? `## 上轮尚未集成的Work Order\n${JSON.stringify(state.pendingJobs)}` : '',
          state.pendingFeedback ? `## 最新待裁决反馈 / 检查与审查结果\n${state.pendingFeedback}` : '',
          '不得重复派发已合入、已验证或已替代的Work Order。重试 status=rejected 的Work Order必须原样复用其 id，或用 replaces 指明原Work Order id。verify 时须在 ignoredFindings 中按验证缺陷 ID 逐条写明不采纳的客观依据。无具体缺陷的失败Work Order按Work Order ID 裁决。前序轮次已记录的依据继续有效。对同一 HEAD 的 REQUEST_CHANGES，须在本轮对每条未采纳意见按编号或标题给出客观 reason。',
          `## 输出格式要求（严格遵守）\n请在回复末尾输出一个 \`\`\`json 代码块，action 取值之一：\n1. \`"dispatch"\`：并发派发 1–12 个无相互阻塞依赖的Work Order（可同时涵盖 architect / builder / verifier）：\n\`\`\`json\n{\n  "action": "dispatch",\n  "milestone": "一句话进度说明",\n  "ignoredFindings": [{"id": "#1", "reason": "忽略该非阻塞意见的客观依据"}],\n  "jobs": [\n    {"id": "arch-core", "trade": "architect", "difficulty": "normal", "title": "建立骨架与Lint", "task": "自足任务说明"},\n    {"id": "impl-mod-a", "trade": "builder", "difficulty": "normal", "lockSpec": true, "title": "实现模块A", "task": "自足任务说明"}\n  ]\n}\n\`\`\`\n2. \`"verify"\`：全部实现已合入且must均已闭环，进入 Stage 3 全量Dual-Track Verification与交付：\n\`\`\`json\n{\n  "action": "verify",\n  "report": "面向用户的 5–8 行改动汇报（做了什么 + 风险提示）",\n  "ignoredFindings": []\n}\n\`\`\`\n3. \`"escalate"\`：发现超出 PLAN_5L.md 边界的重大风险，需请顶层Interactor拍板：\n\`\`\`json\n{\n  "action": "escalate",\n  "question": "需要Interactor/用户拍板的具体问题与可选方案"\n}\n\`\`\``,
        ].filter(Boolean).join('\n\n');
        writeFileSync(promptFile, prompt);

        const args = state.leadSession
          ? ['--continue', state.leadSession, '--json', '--prompt-file', promptFile]
          : ['--commit', fetchedHead, '--title', `执行Lead：${state.title}`, ...agentArgs(settings.lead), '--json', '--prompt-file', promptFile];
        let call = callCodaAgent(args, root);
        if (call.status !== 0 && state.leadSession) {
          call.session ||= state.leadSession;
          console.error(`Lead续跑失败，重建会话：${agentFailure(call)}`);
          state.leadFailures = [...(state.leadFailures ?? []), agentResult(call)];
          state.leadSession = null;
          saveState(state);
          writeFileSync(promptFile, initialContext() + '\n\n' + prompt);
          call = callCodaAgent(['--commit', fetchedHead, '--title', `执行Lead：${state.title}`, ...agentArgs(settings.lead), '--json', '--prompt-file', promptFile], root);
        }
        if (call.status !== 0 || !call.session) {
          call.failureKind ||= 'invalid_output';
          state.leadFailures = [...(state.leadFailures ?? []), agentResult(call)];
          saveState(state);
          throw new Error(`执行Lead会话调用失败：${agentFailure(call)}`);
        }

        const decision = extractJsonBlock(call.parsed.answer ?? '');
        requireValue(decision && ['dispatch', 'verify', 'escalate', 'abort'].includes(decision.action), `执行Lead未输出合法的 action JSON（dispatch|verify|escalate|abort）\n${agentFailure({ ...call, failureKind: 'invalid_output' })}`);

        const ignored = decision.ignoredFindings ?? [];
        const hasReason = item => typeof item?.reason === 'string' && item.reason.trim();
        requireValue(Array.isArray(ignored) && ignored.every(hasReason), 'ignoredFindings 中每项都须提供非空的客观 reason');
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
          const jobs = enrichDispatchBatch(decision.jobs, state.ledger, settings).map(job => ({ ...job, baseHead: fetchedHead }));
          nextState.pendingJobs = jobs;
          // Bind a ticket-level ruling to the report it judged before a retry can change the findings.
          const verifiers = new Set(jobs.filter(job => job.trade === 'verifier').flatMap(job => [job.id, job.replaces].filter(Boolean)));
          nextState.ignoredFindings = nextState.ignoredFindings.map(ruling => {
            if (!verifiers.has(ruling.id) || ruling.jobOnly) return ruling;
            const musts = state.ledger[ruling.id]?.openMusts ?? [];
            return musts.length === 1 ? { ...ruling, id: musts[0].id } : { ...ruling, jobOnly: true };
          });
          mkdirSync(join(env.CODA_ARTIFACTS, 'workers'), { recursive: true });
          mkdirSync(join(env.CODA_ARTIFACTS, 'jobs'), { recursive: true });
          for (const j of jobs) {
            saveRunJson(`jobs/${round}-${j.id}.json`, j);
          }
          saveRunJson(`batch-${round}.json`, jobs);
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
          const pending = Object.values(state.ledger).filter(job => job.status === 'pending');
          requireValue(!pending.length, `仍有未完成的Work Order：${pending.map(job => job.id).join('、')}`);
          const available = nextState.ignoredFindings.filter(hasReason);
          const unresolved = [];
          const rejected = Object.values(state.ledger).filter(job => job.status === 'rejected');
          const replacedVerifiers = new Set(rejected.filter(job => job.trade === 'verifier').map(job => job.replaces));
          for (const job of rejected) {
            const musts = job.openMusts ?? [];
            // The replacement carries the findings, so its predecessor needs no separate ruling.
            if (!musts.length && replacedVerifiers.has(job.id)) continue;
            for (const finding of musts.length ? musts : [job]) {
              const index = available.findIndex(f => f.id === finding.id || (musts.length === 1 && f.id === job.id && !f.jobOnly));
              if (index >= 0) available.splice(index, 1);
              else {
                const label = `${job.trade === 'verifier' ? '验证' : '编码'}Work Order：${job.id}`;
                unresolved.push(musts.length ? `${label} 缺少 ${finding.id} ${findingTitle(finding)} 的依据` : label);
              }
            }
          }
          requireValue(!unresolved.length, `仍有被打回的${unresolved.join('、')}。请重派或在 ignoredFindings 中按上述 ID 逐条写明不采纳的客观依据。`);
          if (requestedChanges(state, fetchedHead)) {
            const reviewIgnored = ignored.filter(f => available.includes(f));
            requireValue(reviewIgnored.length, '同一提交的 REQUEST_CHANGES 须在本轮 ignoredFindings 中逐条写明不采纳依据');
            const remaining = [...reviewIgnored];
            const rulings = state.openReviewFindings.map((finding, idx) => {
              const id = finding.id || `#${idx + 1}`;
              const ruling = remaining.find(f => f.id === id) ?? remaining.find(f => !f.id && finding.title && f.title === finding.title);
              requireValue(ruling, `ignoredFindings 缺少 ${id} ${finding.title} 的不采纳依据`);
              remaining.splice(remaining.indexOf(ruling), 1);
              return { ...ruling, id, title: finding.title };
            });
            if (state.verifiedHead === fetchedHead) {
              nextState.rebuttedReviewHead = fetchedHead;
              nextState.reviewRebuttals = rulings.length ? rulings : reviewIgnored;
              nextState.ignoredFindings = nextState.ignoredFindings.filter(f => !reviewIgnored.includes(f) || (rulings.length && remaining.includes(f)));
            }
          }
          nextState.report = (decision.report || state.report || `已完成需求：${state.title}`).trim();
          saveState(nextState);
          appendGithubOutput({ route: 'verify', jobs: '[]', jobIds: '', milestone: '进入Dual-Track Verification', escalation: '' });
        } else if (decision.action === 'escalate') {
          const question = String(decision.question || decision.reason || '需要决策层确认方案边界').trim();
          nextState.escalation = question;
          saveState(nextState);
          appendGithubOutput({ route: 'escalate', jobs: '[]', jobIds: '', milestone: '', escalation: question });
        } else {
          nextState.abortReason = String(decision.reason || 'Lead中止执行').trim();
          saveState(nextState);
          appendGithubOutput({ route: 'abort', jobs: '[]', jobIds: '', milestone: '', escalation: nextState.abortReason });
        }
        break;
      }

      case 'worker': {
        const root = repo();
        const supplied = env.JOB ? JSON.parse(env.JOB) : null;
        let job = persistentDir || !supplied ? readRunJson(`jobs/${state.round}-${env.JOB_ID || supplied.id}.json`) : supplied;
        const outDir = join(env.CODA_ARTIFACTS, 'workers');
        mkdirSync(outDir, { recursive: true });
        const resultName = `workers/${state.round}-${job.id}.json`;
        const baseHead = fetchHead(state.remote, state.reqBranch);
        const previous = recoverWorker(job, existsSync(join(runDir, resultName)) ? readRunJson(resultName) : null);
        if (previous) {
          if (previous.runId === env.GITHUB_RUN_ID && previous.round === state.round && previous.id === job.id
            && previous.status === 'succeeded') {
            const remoteHead = previous.jobRef
              ? remoteGit('.', 'ls-remote', '--heads', state.remote, `refs/heads/${previous.jobRef}`).split('\t')[0] : baseHead;
            requireValue(!remoteHead || remoteHead === (previous.jobRef ? previous.head : previous.baseHead),
              `Work Order ${job.id} 的远端交付已改变，拒绝覆盖 ${previous.jobRef}`);
            if (remoteHead) {
              requireValue(previous.baseHead === baseHead, `Work Order ${job.id} 已有成功交付，基线已改变，请先由 Lead 回收结清，拒绝覆盖 ${previous.head}`);
              saveRunJson(resultName, previous);
              appendGithubOutput({ id: job.id, status: previous.status });
              break;
            }
          }
          if (previous.retainedRef) job = { ...job, previousHead: previous.head, previousRef: previous.retainedRef, previousFeedback: previous.error };
        }
        const upstreamCommit = job.trade === 'verifier' ? '' : fetchHead(state.remote, state.base);
        git('checkout', '--detach', baseHead);

        const promptFile = join(env.RUNNER_TEMP, `worker-${job.id}.md`);
        const prompt = [
          rolePrompt(job.trade),
          `## 当前项目已启用规范摘要\n${enabledGuidelinesDigest(root)}`,
          `## Work Order信息\n- Work Order ID：\`${job.id}\`\n- 工种级别：\`${job.trade} / ${job.tier}\`（${job.agentSummary}，原因：${job.escalationReason}）\n- 标题：${job.title}\n${job.lockSpec ? '- Spec Lock：禁止修改 `.dickda/lints/` 与 `.dickda/verifiers/`\n' : ''}`,
          job.previousFeedback ? `## 前序打回原因（第 ${job.rejections} 次打回）\n${job.previousFeedback}` : '',
          job.openMusts?.length ? `## 前序未闭环的must缺陷\n${JSON.stringify(job.openMusts, null, 2)}\n请逐项复测，复报缺陷时沿用其 id。全部通过（"passed": true 且 findings 中无 must）将关闭全部历史must。若 "passed": false，仅在 "resolved": ["<id>"] 中列出实际复测确认已修复的历史 ID，未列出的继续保持开启。` : '',
          job.previousHead && job.previousRef ? `## 复用前序提交\npreviousHead：${job.previousHead}\n保留分支：${job.previousRef}\n先运行 git fetch ${state.remote} ${job.previousRef}，用 git show ${job.previousHead} 查看改动。可用 git cherry-pick ${job.previousHead} 或挑选其中需要的提交，复用后修订。` : '',
          upstreamCommit ? `处理合并冲突时，可拉取目标分支 ${state.base}，将上游提交 ${upstreamCommit} 合入当前Work Order。Spec Lock允许从该提交原样合入的规约。` : '',
          `## 任务书\n${job.task}`,
          job.trade === 'verifier'
            ? `完成后必须在回复最后附上结构化 \`\`\`json 块，例如 \`{"passed": false, "summary": "结论", "findings": [{"level": "must", "title": "...", "detail": "..."}]}\`。全部通过且无 must 时写 "passed": true。`
            : `完成后确保改动已提交到当前分支（不要推送或开 PR），并以单独一行「交付说明」汇报完成情况与自检命令。`,
        ].filter(Boolean).join('\n\n');
        writeFileSync(promptFile, prompt);

        const args = [
          '--commit', baseHead,
          '--title', `[${job.trade}/${job.tier}] ${job.title}`,
          ...agentArgs(job.agent),
          '--json',
          '--prompt-file', promptFile,
        ];
        const call = job.trade === 'verifier' ? callCodaAgent(args, root)
          : callDeliveryAgent(args, { cwd: root, baseHead, promptFile });

        const workerHead = job.trade === 'verifier' ? null : call.head;
        const isAncestor = !workerHead || spawnSync('git', ['-C', root, 'merge-base', '--is-ancestor', workerHead, baseHead]).status === 0;
        const isStrictDescendant = !isAncestor && spawnSync('git', ['-C', root, 'merge-base', '--is-ancestor', baseHead, workerHead]).status === 0;
        let record;
        if (call.status !== 0 || !call.session) {
          call.failureKind ||= 'invalid_output';
          record = { ...job, status: 'failed', passed: false, error: 'Work Order会话调用失败' };
        } else if (job.trade === 'verifier') {
          const evaluated = evaluateVerifierAnswer(call.parsed.answer ?? '');
          record = {
            ...job,
            status: !evaluated.valid ? 'failed' : evaluated.passed ? 'succeeded' : 'rejected',
            session: call.parsed.session,
            passed: evaluated.passed,
            summary: evaluated.summary,
            findings: evaluated.findings,
            resolved: evaluated.resolved,
            failureKind: !evaluated.valid ? 'invalid_output' : evaluated.passed ? null : 'gate_rejected',
            ...(evaluated.error ? { error: evaluated.error } : {}),
          };
        } else {
          if (isAncestor) {
            record = { ...job, status: 'rejected', head: workerHead, error: 'Work Order未产生新的 Git 提交（最多续跑 2 次）' };
          } else if (!isStrictDescendant) {
            record = { ...job, status: 'rejected', head: workerHead, error: `Work Order返回的提交（${workerHead}）不是Requirement Branch基线（${baseHead}）的严格后代` };
          } else {
            git('checkout', '--detach', '--quiet', workerHead);
            const lockCheck = job.lockSpec ? checkSpecLock(root, baseHead, workerHead, { upstreamCommit }) : { ok: true, violations: [] };
            if (!lockCheck.ok) {
              record = {
                ...job,
                status: 'rejected',
                error: `违反Spec Lock：实现Work Order不得擅自修改 ${lockCheck.violations.join('、')}`,
              };
            } else {
              const lintRes = runLints(root);
              if (!lintRes.passed) {
                const detail = lintRes.results.filter(r => !r.passed).map(r => `${r.path}: ${r.output}`).join('; ');
                record = { ...job, status: 'rejected', error: `L2 Executable Spec Lint 未通过：${detail}` };
              } else {
                record = {
                  ...job,
                  status: 'succeeded',
                  session: call.parsed.session,
                  head: workerHead,
                  jobRef: `${jobRefPrefix(job.id)}${workerHead}`.slice('refs/heads/'.length),
                  answer: (call.parsed.answer ?? '').slice(-1500),
                };
              }
            }
          }
        }
        record = {
          ...agentResult(call), ...record, session: call.session, baseHead, runId: env.GITHUB_RUN_ID, round: state.round,
          failureKind: record.failureKind ?? call.failureKind ?? (record.status === 'succeeded' ? null : 'gate_rejected'),
          ...(call.attempts ? { deliveryAttempts: call.attempts } : {}),
        };
        if (record.status !== 'succeeded') record.error = `${record.error}\n${agentFailure({ ...call, failureKind: record.failureKind })}`;
        if (isStrictDescendant && record.status !== 'succeeded') {
          record.head = workerHead;
          record.retainedRef = `${jobRefPrefix(job.id)}${workerHead}`;
        }
        record.retainedRefs = [...new Set([
          ...previous?.retainedRefs ?? [], previous?.retainedRef, job.previousRef,
        ].filter(Boolean))];
        const ref = record.jobRef ? `refs/heads/${record.jobRef}` : record.retainedRef;
        if (ref) {
          const publication = { resultStatus: record.status, failureKind: record.failureKind, error: record.error };
          // Persist the checked delivery before exposing its immutable, attempt-specific remote ref.
          saveRunJson(resultName, { ...record, status: 'publishing', publication });
          try {
            remoteGit('.', 'push', '--quiet', '--no-follow-tags', state.remote, `${workerHead}:${ref}`);
          } catch (error) {
            saveRunJson(resultName, { ...record, status: 'failed', failureKind: 'agent_error',
              error: `Work Order交付推送失败：${error.message}`, publication: { ...publication, status: 'failed' } });
            throw error;
          }
        }
        saveRunJson(resultName, record);
        appendGithubOutput({ id: job.id, status: record.status });
        break;
      }

      case 'integrate': {
        appendGithubOutput(settleBatch());
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
        const msg = `顶层Interactor对风险升级的指示：\n${reply.note || '请按当前边界继续推进'}`;
        saveState({ ...state, pendingFeedback: [state.pendingFeedback, msg].filter(Boolean).join('\n\n') });
        appendGithubOutput({ route: 'continue' });
        break;
      }

      case 'archive-delivery': {
        const root = repo();
        let head = fetchHead(state.remote, state.reqBranch);
        git('checkout', '--detach', head);

        const before = head;
        const archive = remember(root);
        if (archive.archived) {
          git('add', '-A', '.dickda/learning', '.dickda/tasks/logs');
          git('commit', '-m', `chore(dickda): archive investigation log (${archive.path})`);
          head = git('rev-parse', 'HEAD');
          requireValue(!git('ls-tree', '--name-only', before, '--', archive.path)
            && git('ls-tree', '-r', '--name-only', head, '--', archive.path), `Investigation Archive 未写入目标提交：${archive.path}`);
          remoteGit('.', 'push', '--quiet', '--no-follow-tags', state.remote, `${head}:refs/heads/${state.reqBranch}`);
        }

        const archivePaths = [...new Set([...(state.archivePaths ?? []), state.archivePath, state.lastArchive, archive.path].filter(Boolean))]
          .filter(path => git('ls-tree', '-r', '--name-only', head, '--', path));
        const archivePath = archivePaths.at(-1) || '';
        const archived = archivePaths.length > 0;
        const nextState = { ...state, head, archived, archivePath, archivePaths, lastArchive: archivePath };
        saveState(nextState);
        appendGithubOutput({
          head,
          archived,
          archivePath,
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
        const reason = `提交 ${state.head} 调用 review-commit 能力异常失败（运行 coda://workflow-runs/${env.GITHUB_RUN_ID}），尚未完成Independent Code Review，不能放行交付。`;
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
          saveState({ ...state, pendingFeedback: '预览准备阶段需要调整，请继续修复并合入Requirement Branch。' });
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
        const reason = env.REASON?.trim() || '用户暂不开工，保留Requirement Branch方案。';
        saveState({ ...state, stopReason: reason });
        if (env.GITHUB_STEP_SUMMARY) writeFileSync(env.GITHUB_STEP_SUMMARY, `## 停止交付\n\n${reason}\n\n保留分支：\`${state.reqBranch}\`\n`, { flag: 'a' });
        appendGithubOutput({ reason });
        break;
      }

      default:
        throw new Error(`未知 dickda 步骤：${action}`);
    }
  } catch (error) {
    console.error(`dickda: ${error.message}`);
    process.exitCode = 1;
  }
}
