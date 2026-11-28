import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { plugin, requireValue } from './store.mjs';

export const ROLES = ['interactor', 'thinker', 'lead', 'architect', 'builder', 'verifier'];
export const TRADES = ['architect', 'builder', 'verifier'];
export const TIERS = ['standard', 'senior'];

export const DEFAULT_SETTINGS = {
  'dickda.interactor': { agent: 'antigravity', mode: 'full', model: 'gemini-4-neon', effort: 'xhigh' },
  'dickda.thinker': { agent: 'antigravity', mode: 'full', model: 'gemini-4-carbon', effort: 'high' },
  'dickda.thinkerCoordinator': { agent: 'antigravity', mode: 'full', model: 'gemini-4-neon', effort: 'xhigh' },
  'dickda.thinkerCarbon': { agent: 'antigravity', mode: 'full', model: 'gemini-4-carbon', effort: 'high' },
  'dickda.thinkerAstra': { agent: 'codex', model: 'gpt-6.2-astra', effort: 'high' },
  'dickda.lead': { agent: 'antigravity', mode: 'full', model: 'gemini-4-neon', effort: 'xhigh' },
  'dickda.architectStandard': { agent: 'antigravity', mode: 'full', model: 'claude-opus-5-5', effort: 'high' },
  'dickda.architectSenior': { agent: 'antigravity', mode: 'full', model: 'gemini-4-carbon', effort: 'high' },
  'dickda.builderStandard': { agent: 'codex', model: 'gpt-6.2-astra', effort: 'high' },
  'dickda.builderSenior': { agent: 'codex', model: 'gpt-6.2-astra', effort: 'max' },
  'dickda.verifierStandard': { agent: 'codex', model: 'gpt-6.1-sol', effort: 'high' },
  'dickda.verifierSenior': { agent: 'codex', model: 'gpt-6.1-sol', effort: 'max' },
  'dickda.escalationThreshold': 2,
  'dickda.mergeMethod': 'merge',
};

export const ROLE_LABELS = {
  interactor: { group: 'Interactor', title: 'Interactor', tiered: false },
  thinker: { group: 'Thinker', title: 'Thinker', tiered: false },
  thinkerCoordinator: { group: 'Thinker', title: 'Thinker · Heavy Mode · Coordinator', tiered: false },
  thinkerCarbon: { group: 'Thinker', title: 'Thinker · Heavy Mode · Carbon', tiered: false },
  thinkerAstra: { group: 'Thinker', title: 'Thinker · Heavy Mode · Astra', tiered: false },
  lead: { group: 'Executors', title: 'Executors · Lead', tiered: false },
  architect: { group: 'Executors', title: 'Executors · Architect', tiered: true },
  builder: { group: 'Executors', title: 'Executors · Builder', tiered: true },
  verifier: { group: 'Executors', title: 'Executors · Verifier', tiered: true },
};

function normalizeAgent(spec, label) {
  requireValue(spec && typeof spec === 'object' && !Array.isArray(spec) && typeof spec.agent === 'string' && spec.agent.trim(), `${label} 须包含有效的 agent 字段`);
  const clean = { agent: spec.agent.trim() };
  for (const key of ['model', 'effort', 'mode']) {
    if (typeof spec[key] === 'string' && spec[key].trim()) clean[key] = spec[key].trim();
  }
  if (spec.options && typeof spec.options === 'object' && !Array.isArray(spec.options) && Object.keys(spec.options).length) {
    clean.options = spec.options;
  }
  if (clean.agent === 'antigravity') clean.mode = 'full';
  return clean;
}

export function loadSettings(rawEnv = process.env.CODA_PLUGIN_SETTINGS, overrides = {}) {
  const parsed = typeof rawEnv === 'string' && rawEnv.trim() ? JSON.parse(rawEnv) : (rawEnv && typeof rawEnv === 'object' ? rawEnv : {});
  const merged = { ...DEFAULT_SETTINGS, ...parsed };
  for (const [k, v] of Object.entries(overrides)) {
    if (v !== undefined && v !== null && v !== '') merged[k] = v;
  }
  const threshold = Number(merged['dickda.escalationThreshold']);
  requireValue(Number.isInteger(threshold) && threshold >= 1 && threshold <= 5, 'escalationThreshold 须为 1–5 的整数');
  const mergeMethod = merged['dickda.mergeMethod'];
  requireValue(['merge', 'squash', 'rebase'].includes(mergeMethod), 'mergeMethod 须为 merge、squash 或 rebase');
  return {
    interactor: normalizeAgent(merged['dickda.interactor'], 'interactor'),
    thinker: normalizeAgent(merged['dickda.thinker'], 'thinker'),
    thinkerCoordinator: normalizeAgent(merged['dickda.thinkerCoordinator'], 'thinkerCoordinator'),
    thinkerCarbon: normalizeAgent(merged['dickda.thinkerCarbon'], 'thinkerCarbon'),
    thinkerAstra: normalizeAgent(merged['dickda.thinkerAstra'], 'thinkerAstra'),
    lead: normalizeAgent(merged['dickda.lead'], 'lead'),
    architect: {
      standard: normalizeAgent(merged['dickda.architectStandard'], 'architectStandard'),
      senior: normalizeAgent(merged['dickda.architectSenior'], 'architectSenior'),
    },
    builder: {
      standard: normalizeAgent(merged['dickda.builderStandard'], 'builderStandard'),
      senior: normalizeAgent(merged['dickda.builderSenior'], 'builderSenior'),
    },
    verifier: {
      standard: normalizeAgent(merged['dickda.verifierStandard'], 'verifierStandard'),
      senior: normalizeAgent(merged['dickda.verifierSenior'], 'verifierSenior'),
    },
    escalationThreshold: threshold,
    mergeMethod,
  };
}

function parseOverrideAgent(raw) {
  if (!raw) return undefined;
  const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  return parsed && typeof parsed === 'object' && parsed.agent ? parsed : undefined;
}

export function effectiveSettings(env = process.env) {
  return loadSettings(env.CODA_PLUGIN_SETTINGS, {
    'dickda.thinker': parseOverrideAgent(env.THINKER),
    'dickda.thinkerCoordinator': parseOverrideAgent(env.THINKER_COORDINATOR),
    'dickda.thinkerCarbon': parseOverrideAgent(env.THINKER_CARBON),
    'dickda.thinkerAstra': parseOverrideAgent(env.THINKER_ASTRA),
    'dickda.lead': parseOverrideAgent(env.LEAD),
    'dickda.architectStandard': parseOverrideAgent(env.ARCHITECT),
    'dickda.architectSenior': parseOverrideAgent(env.ARCHITECT_SENIOR),
    'dickda.builderStandard': parseOverrideAgent(env.BUILDER),
    'dickda.builderSenior': parseOverrideAgent(env.BUILDER_SENIOR),
    'dickda.verifierStandard': parseOverrideAgent(env.VERIFIER),
    'dickda.verifierSenior': parseOverrideAgent(env.VERIFIER_SENIOR),
  });
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
  let reason = 'Normal 任务';
  let escalated = false;

  if (tier === 'senior') {
    resolvedTier = 'senior';
    reason = 'Lead显式指派Senior Engineer';
    escalated = count > 0 || difficulty === 'hard';
  } else if (difficulty === 'hard') {
    resolvedTier = 'senior';
    reason = 'Hard 任务自动启用Senior Engineer';
    escalated = true;
  } else if (count >= threshold) {
    resolvedTier = 'senior';
    reason = `Standard Engineer已连续被打回 ${count} 次（阈值 ${threshold}），自动升级为Senior Engineer`;
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

// Script outputs are scalar; BPMN assembles the coda-agent context from these fields.
export function reviewerOutputs(agent) {
  return Object.fromEntries(['agent', 'model', 'effort', 'mode'].map(key =>
    [`reviewer${key[0].toUpperCase()}${key.slice(1)}`, agent[key] ?? '']));
}

export function formatAgent(spec) {
  if (!spec) return '未配置';
  return [spec.agent, spec.model, spec.effort, spec.mode].filter(Boolean).join(' / ');
}

export function agentArgs(spec) {
  const clean = normalizeAgent(spec, 'coda-agent');
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
  return Object.keys(ROLE_LABELS).map(role => {
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
      display: `Standard ${formatAgent(settings[role].standard)} ｜ Senior ${formatAgent(settings[role].senior)}`,
    };
  });
}
