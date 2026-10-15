// Copilot's account.getQuota reply, kept separate from the CLI transport. These are account allowances, not a
// chat session's token usage. The newer AI billing and older premium-request billing use different units.
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const count = value => finite(value) && value >= 0;
const line = (value, max = 80) => typeof value === 'string'
  ? [...value.replace(/\p{C}/gu, ' ').replace(/\s+/g, ' ').trim()].slice(0, max).join('') : '';
const number = value => String(value);
const unavailable = label => ({ type: 'error', text: `暂时无法获取${label}：Copilot 没有返回有效额度` });

function allowance(snapshot, label, { unit } = {}) {
  if (!object(snapshot)) return unavailable(label);
  if (snapshot.isUnlimitedEntitlement === true || snapshot.entitlementRequests === -1) {
    return { type: 'stat', label, value: '无限量' };
  }
  const left = finite(snapshot.remainingPercentage) && snapshot.remainingPercentage >= 0 && snapshot.remainingPercentage <= 100
    ? snapshot.remainingPercentage : null;
  const hasCounts = unit && count(snapshot.usedRequests) && count(snapshot.entitlementRequests);
  if (left === null && !hasCounts) return unavailable(label);
  const notes = [];
  if (hasCounts) notes.push(`已用 ${number(snapshot.usedRequests)} / ${number(snapshot.entitlementRequests)} ${unit}`);
  if (unit && count(snapshot.overage) && snapshot.overage > 0) notes.push(`超额 ${number(snapshot.overage)} ${unit}`);
  if (snapshot.overageAllowedWithExhaustedQuota === true) notes.push('允许超额使用');
  else if (snapshot.usageAllowedWithExhaustedQuota === true) notes.push('额度用尽后仍可使用');
  const note = line(notes.join(' · '));
  // The CLI currently fills resetDate with the fetch time; it does not establish a quota reset deadline.
  return { type: 'meter', label,
    ...(left === null ? { value: '剩余额度未知' } : { value: `剩余 ${number(left)}%`, fraction: left / 100 }),
    ...(note ? { note } : {}) };
}

// A missing authentication response is a failed reading, not a sign-out. Never use statusMessage as an identity:
// it can contain diagnostics or credentials. Other auth types may still have account quotas.
export function panel(auth, quota) {
  if (auth?.isAuthenticated === false) return { items: [{ type: 'card', title: 'GitHub Copilot',
    items: [{ type: 'markdown', text: '尚未登录，请在运行机终端运行 copilot login。' }] }] };
  if (auth?.isAuthenticated !== true) throw new Error('Copilot 没有说明登录状态');
  const snapshots = quota?.quotaSnapshots, items = [];
  if (object(snapshots)) {
    for (const [key, label] of [['premium_interactions', '月度额度'], ['chat', '聊天'], ['completions', '代码补全']]) {
      if (!Object.hasOwn(snapshots, key)) continue;
      const snapshot = snapshots[key], billing = key === 'premium_interactions' ? snapshot?.tokenBasedBilling : undefined;
      const name = key === 'premium_interactions' ? billing === true ? 'AI 额度' : billing === false ? '高级请求' : label : label;
      items.push(allowance(snapshot, name, { unit: billing === true ? 'AI credits' : billing === false ? '次' : undefined }));
    }
  }
  if (!items.length) items.push(unavailable('额度'));
  return { items: [{ type: 'card', title: line(auth.login) || 'GitHub Copilot', items }] };
}
