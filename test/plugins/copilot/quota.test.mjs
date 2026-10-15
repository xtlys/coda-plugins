import { test } from 'node:test';
import assert from 'node:assert/strict';
import { panelItems } from '../../../check/panel.mjs';
import { panel } from '../../../plugins/copilot/scripts/quota.mjs';

const auth = { isAuthenticated: true, login: 'octocat', authType: 'user' };
const read = (snapshots, account = auth) => {
  const output = panel(account, { quotaSnapshots: snapshots });
  panelItems(JSON.stringify(output), { actions: {} });
  return output.items[0];
};
const premium = snapshot => read({ premium_interactions: snapshot }).items[0];

test('a signed-out Copilot explains how to log in, while an unknown authentication result fails the reading', () => {
  const output = panel({ isAuthenticated: false }, null);
  assert.deepEqual(output, { items: [{ type: 'card', title: 'GitHub Copilot',
    items: [{ type: 'markdown', text: '尚未登录，请在运行机终端运行 copilot login。' }] }] });
  panelItems(JSON.stringify(output), { actions: {} });
  assert.throws(() => panel({}, {}), /没有说明登录状态/);
  assert.throws(() => panel(undefined, {}), /没有说明登录状态/);
});

test('finite premium requests show the remaining share and request counts', () => {
  assert.deepEqual(premium({ tokenBasedBilling: false, entitlementRequests: 300, usedRequests: 75, remainingPercentage: 75,
    resetDate: '2026-11-01T00:00:00+08:00' }), {
    type: 'meter', label: '高级请求', value: '剩余 75%', fraction: 0.75, note: '已用 75 / 300 次',
  });
  assert.equal(premium({ remainingPercentage: 0.25 }).value, '剩余 0.25%');
});

test('explicit AI billing uses AI credits; a missing billing type never guesses units', () => {
  const snapshot = { entitlementRequests: 30000, usedRequests: 15000, overage: 5, remainingPercentage: 50 };
  assert.deepEqual(premium({ ...snapshot, tokenBasedBilling: true }), {
    type: 'meter', label: 'AI 额度', value: '剩余 50%', fraction: 0.5, note: '已用 15000 / 30000 AI credits · 超额 5 AI credits',
  });
  assert.deepEqual(premium(snapshot), { type: 'meter', label: '月度额度', value: '剩余 50%', fraction: 0.5 });
  assert.equal(premium({ ...snapshot, tokenBasedBilling: 'false' }).label, '月度额度');
});

test('unlimited allowances are stated explicitly, not shown as a full percentage bar', () => {
  assert.deepEqual(read({ premium_interactions: { entitlementRequests: -1, remainingPercentage: 0 },
    chat: { isUnlimitedEntitlement: true }, completions: { remainingPercentage: 80 } }).items, [
    { type: 'stat', label: '月度额度', value: '无限量' },
    { type: 'stat', label: '聊天', value: '无限量' },
    { type: 'meter', label: '代码补全', value: '剩余 80%', fraction: 0.8 },
  ]);
});

test('exhaustion and permission to continue are independent, using only the known overage unit', () => {
  assert.deepEqual(premium({ tokenBasedBilling: false, entitlementRequests: 300, usedRequests: 305, remainingPercentage: 0,
    overage: 5, overageAllowedWithExhaustedQuota: true }), {
    type: 'meter', label: '高级请求', value: '剩余 0%', fraction: 0,
    note: '已用 305 / 300 次 · 超额 5 次 · 允许超额使用',
  });
  assert.equal(premium({ tokenBasedBilling: true, remainingPercentage: 0, overage: 200,
    usageAllowedWithExhaustedQuota: true }).note, '超额 200 AI credits · 额度用尽后仍可使用');
  const item = premium({ remainingPercentage: 0, overageAllowedWithExhaustedQuota: false, usageAllowedWithExhaustedQuota: false });
  assert.equal(item.fraction, 0);
  assert.equal(item.note, undefined);
});

test('a missing percentage stays unknown even when legacy request counts are available', () => {
  assert.deepEqual(premium({ tokenBasedBilling: false, entitlementRequests: 300, usedRequests: 75 }), {
    type: 'meter', label: '高级请求', value: '剩余额度未知', note: '已用 75 / 300 次',
  });
  assert.deepEqual(premium({ tokenBasedBilling: true, entitlementRequests: 300, usedRequests: 0 }), {
    type: 'meter', label: 'AI 额度', value: '剩余额度未知', note: '已用 0 / 300 AI credits',
  });
  assert.equal(premium({ entitlementRequests: 300, usedRequests: 0 }).type, 'error');
});

test('missing and malformed quota data are explicit errors, not zero or unlimited', () => {
  for (const quota of [undefined, null, {}, { quotaSnapshots: null }, { quotaSnapshots: [] }, { quotaSnapshots: {} },
    { quotaSnapshots: { unknown: { remainingPercentage: 100 } } }]) {
    const output = panel(auth, quota);
    assert.deepEqual(output.items[0].items, [{ type: 'error', text: '暂时无法获取额度：Copilot 没有返回有效额度' }]);
    panelItems(JSON.stringify(output), { actions: {} });
  }
  for (const snapshot of [null, [], {}, { remainingPercentage: NaN }, { remainingPercentage: Infinity },
    { remainingPercentage: '100' }, { remainingPercentage: -1 }, { remainingPercentage: 101 },
    { isUnlimitedEntitlement: 'true' }, { tokenBasedBilling: false, entitlementRequests: NaN, usedRequests: 0 },
    { tokenBasedBilling: false, entitlementRequests: 300, usedRequests: -5 }]) {
    const item = premium(snapshot);
    assert.equal(item.type, 'error');
    assert.equal(item.fraction, undefined);
  }
});

test('resetDate never becomes a reset deadline because its server semantics are not reliable', () => {
  for (const resetDate of [undefined, null, 1793491200000, '', 'tomorrow', '2026-10-01T00:00:00Z',
    '2026-10-15T12:00:00Z', '2026-11-01T00:00:00Z', '2026-02-30T00:00:00Z', '2026-11-31T00:00:00Z', '2026-11-01T24:00:00Z',
    '2026-11-01T00:00:00+24:00', '2026-11-01T00:00:00+08:60']) {
    assert.equal(premium({ remainingPercentage: 50, resetDate }).time, undefined, String(resetDate));
  }
  assert.equal(premium({ remainingPercentage: 50, resetDate: '2028-02-29T00:00:00Z' }).timeLabel, undefined);
});

test('card identity is bounded text from login; diagnostic messages and other auth types do not decide quota access', () => {
  const result = read({ chat: { remainingPercentage: 50 } }, { isAuthenticated: true,
    login: `\0  张三\n${'猫'.repeat(100)}\u202e`, authType: 'token', statusMessage: 'secret diagnostic token' });
  assert.equal([...result.title].length, 80);
  assert.match(result.title, /^张三 猫/);
  assert.doesNotMatch(result.title, /[\0\n\u202e]/);
  assert.equal(result.items[0].fraction, 0.5);
  assert.equal(read({}, { isAuthenticated: true, statusMessage: 'secret diagnostic token' }).title, 'GitHub Copilot');
  assert.equal(JSON.stringify(result).includes('secret'), false);
});
