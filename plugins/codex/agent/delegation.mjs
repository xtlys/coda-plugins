// Coda's per-turn delegation policy. The locked Codex has no live feature-config update: a changed policy must cold
// resume the same idle thread after unsubscribing. A warm resume explicitly ignores config overrides. Keep the native
// baseline, disable both native delegation runtimes (and their guidance), and replace the current policy instructions.
// `_coda/delegation/configure` applies settings and reads Codex's own response before Coda delivers any task input.
import { isDeepStrictEqual } from 'node:util';
import { existsSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { nativeServiceTier } from './options.mjs';

const sessions = new WeakMap();
const configuring = new WeakMap();
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.length > 0;
const unsupported = 'Coda 委派策略只支持已验证的 Codex 0.162.1';
const noChildren = 'This is a Coda child session. Complete the assigned task yourself. Do not create or delegate to subagents.';

export function codexDelegationCapability(client) {
  // The prefix is the ACP client's name, not necessarily `codex_cli_rs`; the version is Codex's own.
  return /^[^\s]+\/0\.162\.1(?:\s|$)/.test(client.codaNativeUserAgent ?? '')
    ? { delegation: { version: 1, perTurn: true, disableNative: true, actualExecution: true } } : {};
}

export function codexDelegationPolicy(value) {
  if (value === undefined) return { version: 1, active: false };
  if (!record(value) || value.version !== 1 || typeof value.active !== 'boolean') throw new Error('无效的 Coda 委派策略版本或开关');
  if (!value.active) return { version: 1, active: false };
  if (!['parent', 'child'].includes(value.role) || !text(value.instructions)) throw new Error('Coda 委派策略缺少角色或当轮指令');
  if (value.childInstructions !== undefined && typeof value.childInstructions !== 'string') throw new Error('Coda 子会话指令必须是文本');
  if (!Array.isArray(value.policies) || value.policies.some(policy => !record(policy) || !text(policy.id) || !text(policy.plugin) || !text(policy.version)))
    throw new Error('Coda 委派策略缺少策略版本');
  return { version: 1, active: true, role: value.role, instructions: value.instructions,
    ...(value.childInstructions === undefined ? {} : { childInstructions: value.childInstructions }),
    policies: value.policies.map(({ id, plugin, version }) => ({ id, plugin, version })) };
}

// 0.162.1 does NOT support the newer disable_native_tools flag. Disable V1 and V2 together, including model-selected
// V2 behavior via agents.enabled. One table override avoids hash-map ordering conflicts with CODEX_CONFIG tables.
export function codexDelegationConfig(base, policy) {
  if (!policy.active) return base;
  const features = record(base.features) ? base.features : {};
  const config = { ...base };
  for (const key of Object.keys(config)) if (key === 'features.multi_agent' || key === 'features.multi_agent_v2' || key.startsWith('features.multi_agent_v2.') || key === 'agents.enabled') delete config[key];
  return { ...config, features: { ...features, multi_agent: false, multi_agent_v2: false }, agents: { ...(record(base.agents) ? base.agents : {}), enabled: false } };
}

const policyText = policy => policy.active ? [
  'This is the current Coda delegation policy. It replaces all earlier Coda or native multi-agent delegation guidance for this turn.',
  policy.instructions,
  policy.role === 'child' ? noChildren : 'Delegate only through the Coda spawn and send tools. Native subagent tools are disabled.',
].join('\n\n') : 'The Coda delegation policy is now disabled. Earlier Coda parent/child delegation instructions no longer apply. Follow the current native delegation mode and the user\'s instructions.';

export function codexDelegationTurn(client, sessionId) {
  const kept = sessions.get(client)?.get(sessionId);
  if (!kept?.policy.active && !kept?.hadPolicy) return {};
  return { additionalContext: { 'coda/delegation': { kind: 'application', value: policyText(kept.policy) } } };
}

// Title generation is an auxiliary native thread too. It must not offer an uncounted native delegation escape while
// the session's Coda policy is active. Its own title instructions and model remain the adapter's responsibility.
export function codexDelegationAuxiliary(client, sessionId) {
  const policy = sessions.get(client)?.get(sessionId)?.policy;
  return policy?.active ? { config: codexDelegationConfig({}, policy) } : {};
}

export async function openCodexDelegation(client, request, operation, params) {
  const policy = codexDelegationPolicy(request._meta?.coda?.delegation);
  if (policy.active && !codexDelegationCapability(client).delegation) throw new Error(unsupported);
  let kept = sessions.get(client);
  if (!kept) { kept = new Map(); sessions.set(client, kept); }
  const previous = kept.get(request.sessionId);
  // A second load on the same connection is a warm rejoin, not a config update. Fence policy changes here too.
  if (operation !== 'start' && previous && previous.policy.active !== policy.active) {
    const thread = (await client.threadRead({ threadId: request.sessionId })).thread;
    if (!['idle', 'notLoaded'].includes(thread.status?.type)) throw new Error('Codex 原生线程仍有活动，暂时不能切换委派策略');
    if (thread.status.type === 'idle' && (await client.threadBackgroundTerminalsList({ threadId: request.sessionId })).data.length)
      throw new Error('Codex 仍有后台命令，暂时不能切换委派策略');
    await client.threadUnsubscribe({ threadId: request.sessionId });
  }
  const response = await client[operation === 'start' ? 'threadStart' : 'threadResume']({ ...params,
    config: codexDelegationConfig(params.config, policy) });
  kept.set(response.thread.id, { baseline: params, policy, prepared: null, requiresConfirmation: policy.active,
    hadPolicy: policy.active || previous?.hadPolicy || operation !== 'start' && request._meta?.coda?.delegation !== undefined,
    materialized: operation !== 'start', rolloutPath: response.thread.path });
  return response;
}

const execution = (state, ModelId) => {
  const { model, effort } = ModelId.fromString(state.currentModelId);
  const available = state.availableModels.find(item => item.id === model);
  return { agent: 'codex', model, ...(effort ? { effort } : {}),
    ...(available?.serviceTiers?.length ? { options: { 'service-tier': nativeServiceTier(state.serviceTier) } } : {}) };
};
const observedExecution = (response, state) => {
  const model = state.availableModels.find(item => item.id === response.model);
  return { agent: 'codex', model: response.model, ...(response.reasoningEffort == null ? {} : { effort: response.reasoningEffort }),
    ...(model?.serviceTiers?.length ? { options: { 'service-tier': nativeServiceTier(response.serviceTier) } } : {}) };
};
const satisfies = (actual, expected) => record(expected) && expected.agent === 'codex' && text(expected.model)
  && actual.model === expected.model && (expected.effort === undefined || actual.effort === expected.effort)
  && (expected.options === undefined || record(expected.options) && Object.entries(expected.options).every(([id, value]) => isDeepStrictEqual(actual.options?.[id], value)));
const fail = (RequestError, reason) => { throw RequestError.invalidParams(void 0, reason); };

export async function configureCodexDelegation(agent, params, { RequestError, ModelId }) {
  if (!record(params) || !text(params.sessionId)) fail(RequestError, '缺少 Coda 委派会话');
  if (!codexDelegationCapability(agent.codexAcpClient.codexClient).delegation) fail(RequestError, unsupported);
  if (configuring.has(agent)) fail(RequestError, 'Coda 委派配置正在应用');
  if (agent.activePrompts.has(params.sessionId) || agent.pendingTurnStarts.has(params.sessionId)) fail(RequestError, '只能在轮次边界应用 Coda 委派策略');
  const state = agent.getSessionState(params.sessionId), native = agent.codexAcpClient.codexClient;
  const kept = sessions.get(native)?.get(params.sessionId);
  if (!kept) fail(RequestError, '没有可核对的 Codex 会话配置基线');
  let policy;
  try { policy = codexDelegationPolicy(params.delegation); } catch (error) { fail(RequestError, error.message); }
  const desired = execution(state, ModelId);
  if (!satisfies(desired, params.execution)) fail(RequestError, 'Coda 要求的执行配置与已设置的 Codex 配置不一致');
  // A failed/partial configuration must never leave an earlier preparation authorizing a later prompt.
  kept.prepared = null;
  kept.requiresConfirmation ||= policy.active || kept.policy.active;
  configuring.set(agent, params.sessionId);
  try {
    let response;
    // A new Codex thread is speculative until its first user input. Native section placement is its explicit durable
    // checkpoint: keep the newly created thread in its default unsectioned list without inventing any model input.
    if (!kept.materialized) {
      // A normal completed turn may already have materialized this initially speculative thread.
      if (!kept.rolloutPath || !existsSync(kept.rolloutPath))
        await native.sendRequest({ method: 'thread/section/move', params: { threadId: params.sessionId, sectionId: null } });
      kept.materialized = true;
    }
    if (kept.policy.active !== policy.active) {
      const thread = (await native.threadRead({ threadId: params.sessionId })).thread;
      if (!['idle', 'notLoaded'].includes(thread.status?.type)) fail(RequestError, 'Codex 原生线程仍有活动，暂时不能切换委派策略');
      const children = state.subagents;
      if (children.pendingSpawns.size || children.activeLegacyActivities.size || [...children.children.values()].some(child => child.terminalState === undefined))
        fail(RequestError, 'Codex 原生子 Agent 仍在执行，暂时不能切换委派策略');
      if (thread.status.type === 'idle' && (await native.threadBackgroundTerminalsList({ threadId: params.sessionId })).data.length)
        fail(RequestError, 'Codex 仍有后台命令，暂时不能切换委派策略');
      await native.threadUnsubscribe({ threadId: params.sessionId });
      response = await native.threadResume({ ...kept.baseline, excludeTurns: true, threadId: params.sessionId,
        config: { ...codexDelegationConfig(kept.baseline.config, policy), model_reasoning_effort: desired.effort },
        model: desired.model, serviceTier: nativeServiceTier(state.serviceTier) === 'default' ? null : state.serviceTier });
      kept.policy = policy;
    }
    // This ACK is native, unlike codex-acp's in-memory configOptions. A plain resume reads the native values even when
    // the thread is loaded, so an ignored model, effort or service tier cannot be reported as successfully applied.
    await native.threadSettingsUpdate({ threadId: params.sessionId, model: desired.model, effort: desired.effort,
      serviceTier: nativeServiceTier(state.serviceTier) === 'default' ? null : state.serviceTier });
    // The update RPC acknowledges queueing the core operation. Wait for a native snapshot that reflects it; neither
    // the RPC result nor codex-acp's JS state is evidence that the core has already applied the values.
    let actual;
    const deadline = Date.now() + 1000;
    do {
      response = await native.threadResume({ threadId: params.sessionId, excludeTurns: true });
      actual = observedExecution(response, state);
      if (satisfies(actual, desired) || Date.now() >= deadline) break;
      await delay(20);
    } while (true);
    if (!satisfies(actual, desired)) fail(RequestError, `Codex 实际执行配置不符：${JSON.stringify(actual)}`);
    kept.policy = policy;
    kept.prepared = { policy, execution: desired };
    kept.hadPolicy ||= policy.active;
    kept.requiresConfirmation = policy.active;
    return { execution: actual };
  } finally { configuring.delete(agent); }
}

export async function checkCodexDelegationPrompt(agent, params, { RequestError, ModelId }) {
  const state = agent.getSessionState(params.sessionId), native = agent.codexAcpClient.codexClient;
  const kept = sessions.get(native)?.get(params.sessionId);
  let policy;
  try { policy = codexDelegationPolicy(params._meta?.coda?.delegation); } catch (error) { fail(RequestError, error.message); }
  if (configuring.has(agent)) fail(RequestError, 'Coda 委派配置尚未完成');
  if (!policy.active && !kept?.policy.active && !kept?.requiresConfirmation) return;
  if (!kept?.prepared || !isDeepStrictEqual(policy, kept.prepared.policy) || !isDeepStrictEqual(execution(state, ModelId), kept.prepared.execution))
    fail(RequestError, '当轮 Coda 委派策略或执行配置尚未通过原生确认');
  if (params._meta?.coda?.delegation?.execution && !satisfies(kept.prepared.execution, params._meta.coda.delegation.execution))
    fail(RequestError, '当轮 Coda 委派执行快照与原生确认不一致');
}

export function delegatedCodexTurns(source) {
  const patches = [
    ['    this.configPath = response?.codexHome ?? null;', '    this.configPath = response?.codexHome ?? null;\n    this.codexClient.codaNativeUserAgent = response?.userAgent ?? null;', 1],
    ['    const response = await this.codexClient.threadStart({', '    const response = await openCodexDelegation(this.codexClient, request, "start", {', 1],
    ['    const response = await this.codexClient.threadResume({', '    const response = await openCodexDelegation(this.codexClient, request, "resume", {', 2],
    ['      serviceTier\n    }, onTurnStarted);', '      serviceTier,\n      ...codexDelegationTurn(this.codexClient, request.sessionId)\n    }, onTurnStarted);', 1],
    ['      cwd: this.cwd,\n      ephemeral: true', '      cwd: this.cwd,\n      ...codexDelegationAuxiliary(this.client, this.mainThreadId),\n      ephemeral: true', 1],
    ['          [AUTH_STATUS_META_KEY]: authStatusCapability()', '          coda: codexDelegationCapability(this.codexAcpClient.codexClient),\n          [AUTH_STATUS_META_KEY]: authStatusCapability()', 1],
    ['    const agentFileChangeReportRequest = clientSupportsAgentFileChangeReports(this.clientCapabilities)',
      '    await checkCodexDelegationPrompt(this, params, { RequestError, ModelId });\n    const agentFileChangeReportRequest = clientSupportsAgentFileChangeReports(this.clientCapabilities)', 1],
    ['.onRequest(SESSION_STEERING_METHOD, sessionSteerParamsParser,',
      '.onRequest("_coda/delegation/configure", params => params, ctx => configureCodexDelegation(getAgent(), ctx.params, { RequestError, ModelId })).onRequest(SESSION_STEERING_METHOD, sessionSteerParamsParser,', 1],
  ];
  for (const [before, after, count] of patches) {
    if (source.split(before).length !== count + 1) throw new Error('codex-acp delegation patch no longer matches the locked adapter');
    source = source.replaceAll(before, after);
  }
  return `import { openCodexDelegation, codexDelegationCapability, configureCodexDelegation, checkCodexDelegationPrompt, codexDelegationTurn, codexDelegationAuxiliary } from ${JSON.stringify(import.meta.url)};\n${source.replace(/^#![^\n]*\n/, '')}`;
}
