import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { config, fingerprint, git, id, json, lock, managed, now, requireValue, save, text } from './store.mjs';
import { documents, freshness } from './knowledge.mjs';

export const phases = ['repro', 'proposal', 'implementation', 'review', 'refine', 'delivery', 'done'];
const location = (root, taskId, file) => managed(root, `TaskLogs/${id(taskId)}/${file}`);
export function task(root, taskId) {
  const t = json(location(root, taskId, 'task.json'));
  requireValue(t.schemaVersion === 1 && phases.includes(t.phase) && t.projectId === config(root).projectId, '任务版本或项目不匹配'); return t;
}
export function start(root, title, request, delivery = 'local') {
  text(title, 'title', 300); text(request, 'request', 100000);
  requireValue(['local', 'pull-request'].includes(delivery), 'delivery 须为 local 或 pull-request');
  const t = { schemaVersion: 1, id: `t-${randomUUID()}`, projectId: config(root).projectId, title, request, delivery,
    phase: 'repro', revision: 0, createdAt: now(), updatedAt: now(), history: [], head: git(root, 'rev-parse', 'HEAD') };
  save(location(root, t.id, 'task.json'), t); return t;
}
export function bind(root, taskId, runId) {
  return lock(root, taskId, () => {
    const t = task(root, taskId);
    if (runId) {
      requireValue(!t.runId || t.runId === runId, `任务已由运行 ${t.runId} 接管，请恢复原运行`);
      t.runId = runId; save(location(root, taskId, 'task.json'), t);
    }
    return t;
  });
}
export function check(root, taskId, command) {
  task(root, taskId); requireValue(command.length > 0, 'check 需要 -- 后面的命令和参数');
  const before = fingerprint(root), checkId = `c-${randomUUID()}`;
  const result = spawnSync(command[0], command.slice(1), { cwd: root, encoding: 'utf8', timeout: 600000, maxBuffer: 2 * 1024 * 1024 });
  const entry = { id: checkId, command, exitCode: result.status, error: result.error?.message ?? null,
    stdout: (result.stdout ?? '').slice(-16000), stderr: (result.stderr ?? '').slice(-16000), before, after: fingerprint(root), at: now() };
  save(location(root, taskId, `${checkId}.json`), entry); return entry;
}
function checks(root, t, receipt, mustPass) {
  requireValue(Array.isArray(receipt.checks) && receipt.checks.length > 0, '需要 vczh check 生成的检查 ID');
  const current = fingerprint(root);
  return receipt.checks.map(checkId => {
    const c = json(location(root, t.id, `${id(checkId)}.json`));
    requireValue(Array.isArray(c.command) && c.before === current && c.after === current, `检查 ${checkId} 已过期或检查改变了代码，请重跑`);
    requireValue(!c.error && Number.isInteger(c.exitCode), `检查 ${checkId} 未正常完成`);
    if (mustPass) requireValue(c.exitCode === 0, `检查 ${checkId} 未通过`);
    return c;
  });
}
function validate(root, t, receipt) {
  text(receipt.summary, 'summary');
  switch (t.phase) {
    case 'repro': {
      requireValue(['reproduced', 'specified', 'unavailable'].includes(receipt.outcome), 'repro.outcome 须为 reproduced、specified 或 unavailable');
      if (receipt.outcome === 'unavailable') text(receipt.reason, '无法复现的原因及替代验证');
      else checks(root, t, receipt, false);
      break;
    }
    case 'proposal':
      requireValue(Array.isArray(receipt.candidates) && receipt.candidates.length > 0, '需要至少一个提案');
      for (const p of receipt.candidates) for (const k of ['id', 'title', 'rationale', 'verification']) text(p[k], `candidate.${k}`);
      requireValue(receipt.candidates.some(p => p.id === receipt.selected), 'selected 必须指向已有提案'); break;
    case 'implementation': checks(root, t, receipt, true); break;
    case 'review': {
      requireValue(['approve', 'changes'].includes(receipt.decision), 'review.decision 须为 approve 或 changes');
      requireValue(['self', 'external'].includes(receipt.reviewer), '注明 reviewer 为 self 或 external');
      requireValue(Array.isArray(receipt.findings), '需要 findings 数组；无问题时为空');
      if (receipt.reviewer === 'external') text(receipt.reference, '外部评审出处');
      if (receipt.decision === 'changes') requireValue(receipt.findings.length > 0, '要求修改时须给出具体问题');
      const implementation = t.history.findLast(h => h.phase === 'implementation');
      requireValue(implementation?.fingerprint === fingerprint(root), '实现验证后代码已变化，请重新完成 implementation'); break;
    }
    case 'refine': {
      requireValue(Array.isArray(receipt.documents), '需要 documents 数组');
      if (!receipt.documents.length) text(receipt.noKnowledgeReason, '未产生可复用知识的理由');
      for (const ref of receipt.documents) {
        const doc = documents(root, ref.kind).find(d => d.id === ref.id);
        requireValue(doc && doc.taskIds.includes(t.id), `知识 ${ref.id} 未关联此任务`);
        requireValue(freshness(root, doc) !== 'stale', `知识 ${ref.id} 来源已变，请重新核对`);
      }
      break;
    }
    case 'delivery':
      requireValue(receipt.mode === t.delivery, `本任务交付模式为 ${t.delivery}`);
      if (t.delivery === 'pull-request') requireValue(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/[1-9]\d*$/.test(receipt.pr), '需要 gh pr view 返回的完整 PR 地址');
      break;
    default: throw new Error('任务已经结束');
  }
  if (['refine', 'delivery'].includes(t.phase)) {
    requireValue(t.history.findLast(h => h.phase === 'review')?.fingerprint === fingerprint(root), '评审后代码已变化；用 task revise 退回实现和评审');
  }
}
export function record(root, taskId, receipt) {
  return lock(root, taskId, () => {
    const t = task(root, taskId); validate(root, t, receipt);
    const value = { ...receipt, phase: t.phase, revision: t.revision, fingerprint: fingerprint(root), recordedAt: now() };
    save(location(root, taskId, `evidence-${t.revision}.json`), value); return value;
  });
}
export function advance(root, taskId, phase, revision) {
  return lock(root, taskId, () => {
    const t = task(root, taskId);
    if (t.revision === revision + 1 && t.history.at(-1)?.revision === revision && t.history.at(-1)?.phase === phase) return t;
    requireValue(t.phase === phase && t.revision === revision, '阶段版本已变化，请读取当前任务');
    const evidence = json(location(root, taskId, `evidence-${revision}.json`));
    requireValue(evidence.fingerprint === fingerprint(root), '记录证据后代码变化，请重新验证并记录'); validate(root, t, evidence);
    if (phase === 'review' && evidence.decision === 'changes') {
      const rounds = t.history.filter(h => h.phase === 'review' && h.decision === 'changes').length + 1;
      requireValue(rounds < config(root).maxReviewRounds, '达到评审修改上限。检查提案或授权范围；需要更多轮时明确调整 project.json 的 maxReviewRounds 后恢复原运行');
      t.phase = 'implementation';
    } else t.phase = phases[phases.indexOf(phase) + 1];
    t.history.push(evidence); t.revision++; t.updatedAt = now(); save(location(root, taskId, 'task.json'), t); return t;
  });
}
export function revise(root, taskId, reason) {
  text(reason, 'reason');
  return lock(root, taskId, () => {
    const t = task(root, taskId); requireValue(['review', 'refine', 'delivery', 'done'].includes(t.phase), '只能把评审或沉淀、交付阶段退回实现');
    t.history.push({ phase: t.phase, revision: t.revision, action: 'revise', summary: reason, recordedAt: now() });
    t.phase = 'implementation'; t.revision++; t.updatedAt = now(); save(location(root, taskId, 'task.json'), t); return t;
  });
}
