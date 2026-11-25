export function reviewVerdict(head, review) {
  if (!review || typeof review !== 'object' || !review.decision) {
    return {
      route: 'retry',
      reason: `提交 ${head} 的独立代码审查调用失败或未返回结论，不能放行交付。`,
    };
  }
  if (review.head !== head) {
    return {
      route: 'retry',
      reason: `独立代码审查返回的提交（${review.head || '空'}）与当前交付 HEAD（${head}）不一致，不能放行交付。`,
    };
  }
  if (review.decision === 'INCOMPLETE') {
    return {
      route: 'retry',
      reason: `提交 ${head} 的独立代码审查未完成（INCOMPLETE）：${review.line ?? '未知原因'}`,
    };
  }
  if (review.decision === 'REQUEST_CHANGES') {
    return {
      route: 'changes',
      reason: `### 独立代码审查结论：REQUEST_CHANGES\n${review.line ?? ''}\n${review.report ?? ''}`,
    };
  }
  if (review.decision === 'APPROVE' || review.decision === 'COMMENT') {
    return { route: 'pr', reason: '' };
  }
  return {
    route: 'retry',
    reason: `未知的独立代码审查结论：${review.decision}`,
  };
}

export function jsonList(value) {
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return null; }
  }
  return Array.isArray(value) ? value : null;
}

export function openMusts(review, previous) {
  const findings = jsonList(review.findings);
  const resolutions = jsonList(review.resolutions) ?? [];
  if (!findings || previous.some(f => !resolutions.some(r => r?.id === f.id && ['resolved', 'withdrawn', 'upheld'].includes(r.status)))) return [];
  return [
    ...previous.filter(f => resolutions.some(r => r?.id === f.id && r.status === 'upheld')),
    ...findings.filter(f => f?.level === 'must'),
  ];
}

export function requestedChanges(state, head) {
  return state.review?.decision === 'REQUEST_CHANGES' && state.review.head === head && state.lastReviewedHead === head;
}

export function reviewRange(state) {
  const open = state.openReviewFindings ?? [];
  const incremental = state.head !== state.lastReviewedHead && requestedChanges(state, state.lastReviewedHead)
    && open.length > 0 && new Set(open.map(f => f.id)).size === open.length
    && open.every(f => f.level === 'must' && ['id', 'kind', 'title'].every(key => typeof f[key] === 'string' && f[key].trim())
      && typeof f.location === 'string' && typeof f.detail === 'string');
  return {
    base: incremental ? state.lastReviewedHead : state.baseCommit,
    previous: incremental ? JSON.stringify(open.map(({ id, level, kind, title, location, detail }) => ({ id, level, kind, title, location, detail }))) : '',
  };
}

export function checkRunsText(record, head) {
  if (!record || record.head !== head) return '当前提交尚未完成项目检查。';
  const runs = typeof record.runs === 'string' ? JSON.parse(record.runs) : (record.runs ?? []);
  return runs.map(r => `- ${r.workflow}：${r.state} coda://workflow-runs/${r.runId}`).join('\n') || '项目未声明 check 挂点流程。';
}
