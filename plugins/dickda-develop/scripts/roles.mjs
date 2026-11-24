import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { plugin, requireValue } from './store.mjs';

export const ROLES = ['interactor', 'thinker', 'lead', 'architect', 'builder', 'verifier'];
export const TRADES = ['architect', 'builder', 'verifier'];
export const TIERS = ['standard', 'senior'];

export const DEFAULT_SETTINGS = {
  'dickda-develop.interactor': { agent: 'antigravity', model: 'gemini-4-neon', effort: 'xhigh' },
  'dickda-develop.thinker': { agent: 'antigravity', model: 'gemini-4-carbon', effort: 'high' },
  'dickda-develop.lead': { agent: 'antigravity', model: 'gemini-4-neon', effort: 'xhigh' },
  'dickda-develop.architectStandard': { agent: 'antigravity', model: 'claude-opus-5-5', effort: 'high' },
  'dickda-develop.architectSenior': { agent: 'antigravity', model: 'gemini-4-carbon', effort: 'high' },
  'dickda-develop.builderStandard': { agent: 'codex', model: 'gpt-6.2-astra', effort: 'high' },
  'dickda-develop.builderSenior': { agent: 'codex', model: 'gpt-6.2-astra', effort: 'max' },
  'dickda-develop.verifierStandard': { agent: 'codex', model: 'gpt-6.1-sol', effort: 'high' },
  'dickda-develop.verifierSenior': { agent: 'codex', model: 'gpt-6.1-sol', effort: 'max' },
  'dickda-develop.escalationThreshold': 2,
  'dickda-develop.mergeMethod': 'merge',
};

export const ROLE_LABELS = {
  interactor: { group: '交互者', title: '交互者（Interactor）', tiered: false },
  thinker: { group: '思考者', title: '思考者（Thinker）', tiered: false },
  lead: { group: '执行者', title: '执行者 · 主控（Lead）', tiered: false },
  architect: { group: '执行者', title: '执行者 · 架构（Architect）', tiered: true },
  builder: { group: '执行者', title: '执行者 · 实现（Builder）', tiered: true },
  verifier: { group: '执行者', title: '执行者 · 验证（Verifier）', tiered: true },
};

function validAgent(spec, label) {
  requireValue(spec && typeof spec === 'object' && !Array.isArray(spec) && typeof spec.agent === 'string' && spec.agent.trim(), `${label} 须包含有效的 agent 字段`);
  const clean = { agent: spec.agent.trim() };
  for (const key of ['model', 'effort', 'mode']) {
    if (typeof spec[key] === 'string' && spec[key].trim()) clean[key] = spec[key].trim();
  }
  if (spec.options && typeof spec.options === 'object' && !Array.isArray(spec.options) && Object.keys(spec.options).length) {
    clean.options = spec.options;
  }
  return clean;
}

export function loadSettings(rawEnv = process.env.CODA_PLUGIN_SETTINGS, overrides = {}) {
  const parsed = typeof rawEnv === 'string' && rawEnv.trim() ? JSON.parse(rawEnv) : (rawEnv && typeof rawEnv === 'object' ? rawEnv : {});
  const merged = { ...DEFAULT_SETTINGS, ...parsed };
  for (const [k, v] of Object.entries(overrides)) {
    if (v !== undefined && v !== null && v !== '') merged[k] = v;
  }
  const threshold = Number(merged['dickda-develop.escalationThreshold']);
  requireValue(Number.isInteger(threshold) && threshold >= 1 && threshold <= 5, 'escalationThreshold 须为 1–5 的整数');
  const mergeMethod = merged['dickda-develop.mergeMethod'];
  requireValue(['merge', 'squash', 'rebase'].includes(mergeMethod), 'mergeMethod 须为 merge、squash 或 rebase');
  return {
    interactor: validAgent(merged['dickda-develop.interactor'], 'interactor'),
    thinker: validAgent(merged['dickda-develop.thinker'], 'thinker'),
    lead: validAgent(merged['dickda-develop.lead'], 'lead'),
    architect: {
      standard: validAgent(merged['dickda-develop.architectStandard'], 'architectStandard'),
      senior: validAgent(merged['dickda-develop.architectSenior'], 'architectSenior'),
    },
    builder: {
      standard: validAgent(merged['dickda-develop.builderStandard'], 'builderStandard'),
      senior: validAgent(merged['dickda-develop.builderSenior'], 'builderSenior'),
    },
    verifier: {
      standard: validAgent(merged['dickda-develop.verifierStandard'], 'verifierStandard'),
      senior: validAgent(merged['dickda-develop.verifierSenior'], 'verifierSenior'),
    },
    escalationThreshold: threshold,
    mergeMethod,
  };
}

// Resolve single-tier role (interactor / thinker / lead) or two-tier engineer trade (architect / builder / verifier).
export function resolveEngineer(trade, { tier, difficulty = 'normal', rejections = 0 } = {}, settings = loadSettings()) {
  requireValue(TRADES.includes(trade), `未知工程师工种：${trade}（支持 architect|builder|verifier）`);
  if (tier !== undefined && tier !== null && tier !== '') {
    requireValue(TIERS.includes(tier), `未知工程师级别：${tier}（支持 standard|senior）`);
  }
  requireValue(['normal', 'hard'].includes(difficulty), `未知任务难度：${difficulty}（支持 normal|hard）`);
  const count = Number(rejections) || 0;
  const threshold = settings.escalationThreshold;

  let resolvedTier = 'standard';
  let reason = '常规任务';
  let escalated = false;

  if (tier === 'senior') {
    resolvedTier = 'senior';
    reason = '主控显式指派高级工程师';
    escalated = count > 0 || difficulty === 'hard';
  } else if (difficulty === 'hard') {
    resolvedTier = 'senior';
    reason = '高难任务自动启用高级工程师';
    escalated = true;
  } else if (count >= threshold) {
    resolvedTier = 'senior';
    reason = `常规工程师已连续被打回 ${count} 次（阈值 ${threshold}），自动升级为高级工程师`;
    escalated = true;
  }

  const chosen = settings[trade][resolvedTier];
  return {
    trade,
    tier: resolvedTier,
    escalated,
    rejections: count,
    threshold,
    reason,
    agent: chosen,
    summary: formatAgent(chosen),
  };
}

export function formatAgent(spec) {
  if (!spec) return '未配置';
  return [spec.agent, spec.model, spec.effort, spec.mode].filter(Boolean).join(' / ');
}

export function agentArgs(spec) {
  const clean = validAgent(spec, 'coda-agent');
  const args = [];
  for (const key of ['agent', 'model', 'effort', 'mode']) {
    if (clean[key]) args.push(`--${key}`, clean[key]);
  }
  for (const [optKey, optValue] of Object.entries(clean.options ?? {})) {
    args.push('--option', `${optKey}=${optValue}`);
  }
  return args;
}

export function rolePrompt(role) {
  requireValue(ROLES.includes(role), `未知角色：${role}（支持 ${ROLES.join('|')}）`);
  return readFileSync(join(plugin, 'prompts/roles', `${role}.md`), 'utf8');
}

export function listRoles(settings = loadSettings()) {
  return ROLES.map(role => {
    const meta = ROLE_LABELS[role];
    if (!meta.tiered) {
      return {
        id: role,
        group: meta.group,
        title: meta.title,
        tiered: false,
        default: settings[role],
        display: formatAgent(settings[role]),
      };
    }
    return {
      id: role,
      group: meta.group,
      title: meta.title,
      tiered: true,
      standard: settings[role].standard,
      senior: settings[role].senior,
      escalationThreshold: settings.escalationThreshold,
      display: `常规 ${formatAgent(settings[role].standard)} ｜ 高级 ${formatAgent(settings[role].senior)}`,
    };
  });
}
