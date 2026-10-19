import * as wire from './transport.mjs';
import { DshWaits } from './waits.mjs';
import { questionForm, questionAnswer } from './questions.mjs';
import { authError } from './errors.mjs';
export { turnError } from './errors.mjs';
export { stream } from './transport.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const instructionKey = 'codaSessionInstructions';
export const waitsEnabled = () => object(wire.clientCapabilities._meta?.coda?.waits);
export function sessionInstructions(value) {
  if (value === undefined) return '';
  if (!object(value) || value.mode !== 'append' || !Array.isArray(value.content)
    || value.content.some(b => !object(b) || b.type !== 'text' || typeof b.text !== 'string')) throw new Error('systemPrompt 只接受 append 模式的文本块');
  const text = value.content.map(b => b.text).join('\n\n');
  if (Buffer.byteLength(text, 'utf8') > 1024 * 1024) throw new Error('systemPrompt 超过 1 MiB');
  return text;
}

const modeNames = { 'read-only': '只读', 'workspace-write': '工作区写入，越界时审批', 'danger-full-access': '完全访问，不询问', auto: '自动审批' };
export function toolPresentation(update) {
  if (update.sessionUpdate !== 'tool_call') return update;
  const name = update.title, args = update.rawInput;
  const kinds = { bash: 'execute', bash_persistent: 'execute', pwsh: 'execute', read_file: 'read', read: 'read',
    write_file: 'edit', write: 'edit', edit_file: 'edit', edit: 'edit', str_replace_editor: 'edit',
    grep: 'search', glob: 'search', web_search: 'search', web_fetch: 'fetch', ask_user_question: 'other' };
  const path = object(args) && (args.path ?? args.file_path);
  return { ...update, kind: kinds[name] ?? update.kind, ...(typeof path === 'string' ? { locations: [{ path }] } : {}) };
}

export function install({ ctx, sessions, implementation: api, RequestError, createUserMessage, assistantUpdates, toolCallUpdate, toolResultUpdate }) {
  const invalid = message => new RequestError(-32602, message);
  const get = id => { const record = sessions.get(id); if (!record) throw invalid(`未知会话：${id}`); return record; };
  const waits = new DshWaits(params => wire.notify('_coda/wait', params), waitsEnabled);
  const attached = new Map(), roots = new Map(), cancelled = new Set(), pendingJobs = new Map(), childKeys = new Map();
  const instructionTexts = new WeakMap();
  const childControllers = new Map(), activationKeys = new Map();
  let childSerial = 0;
  const native = Object.fromEntries(Object.entries(api).filter(([, value]) => typeof value === 'function'));
  const emitUpdate = (sessionId, update) => wire.notify('session/update', { sessionId, update: toolPresentation(update) });
  const modeState = record => {
    const presets = record.agent.ctx.get('permissionPresets');
    if (!presets) return undefined;
    return { currentModeId: presets.current(record.agent.session), availableModes: presets.names.map(id => {
      const option = presets.optionOf(id);
      return { id, name: modeNames[id] ?? option.name ?? id, ...(option.description ? { description: option.description } : {}) };
    }) };
  };
  const checkAuth = async provider => {
    if (provider === 'deepseek-official' && !(await ctx.llm.listModels(provider)).length)
      throw new RequestError(-32000, 'DeepSeek 尚未认证：请配置运行机的 API Key。');
  };
  const applyInstructions = async (agent, text, signal) => {
    instructionTexts.set(agent, text);
    if (!text) return;
    const prompt = agent.ctx.get('systemPrompt');
    if (!prompt) throw invalid('此 Harness profile 无法接收 Coda 会话指令');
    prompt.section({ name: 'coda:session-instructions', order: 20000, text, interpolate: false });
    const assembled = await prompt.assemble({ agent, scope: agent, signal });
    if (!assembled.sections.some(section => section.name === 'coda:session-instructions' && section.text === text))
      throw invalid('此 Harness profile 覆盖了系统提示词，无法应用 Coda 会话指令');
  };
  ctx.on('agent/created', async ({ agent, signal }) => {
    const parent = attached.get(agent.session.header.parentSession);
    if (parent) {
      await applyInstructions(agent, instructionTexts.get(parent) ?? '', signal);
      attach(agent, roots.get(parent.id), parent);
    }
  });
  const finishRoot = async agent => {
    const record = sessions.get(roots.get(agent.id));
    await record?.drainUpdates();
    // Later wakes own their own handling interval. Do not close one that already started.
    if (agent.status === 'idle') waits.idle(agent.id, cancelled.delete(agent.id));
  };
  const attach = (agent, rootId, parent) => {
    if (attached.get(agent.id) === agent) return;
    attached.set(agent.id, agent); roots.set(agent.id, rootId);
    let childKey;
    const messageKeys = new Map();
    const startChild = () => {
      if (!parent || childKey) return;
      childKey = `child:${agent.id}:${++childSerial}`;
      childKeys.set(agent.id, childKey);
      const descriptor = agent.session.snapshotEvents().find(event => event.type === 'subagent/descriptor')?.data;
      const title = typeof descriptor?.label === 'string' ? descriptor.label.slice(0, 500) : 'DeepSeek 子 Agent';
      waits.start(parent.id, childKey, { kind: 'subagent', title, childSessionId: agent.id },
        () => { cancelled.add(agent.id); ctx.get('subagents').interrupt(agent.id, { kind: 'ancestor', agent: parent }); });
    };
    if (parent) childControllers.set(agent.id, { start: startChild, key: () => childKey });
    agent.ctx.on('subagent/start', info => {
      const child = ctx.agents.get(info.id);
      if (child) {
        attach(child, rootId, agent);
        childControllers.get(child.id)?.start();
        activationKeys.set(info.runId, childControllers.get(child.id)?.key());
      }
      else waits.start(agent.id, `external:${info.runId}`, { kind: 'subagent', title: 'DeepSeek 子 Agent', childSessionId: info.id });
    });
    agent.ctx.on('subagent/end', info => {
      const terminal = info.stopReason === 'completed' ? 'done' : info.stopReason === 'aborted' ? 'cancelled' : 'failed';
      const key = activationKeys.get(info.runId) ?? childKeys.get(info.id);
      activationKeys.delete(info.runId);
      const finish = () => {
        waits.finish(`external:${info.runId}`, terminal);
        waits.finish(key, terminal);
      };
      const record = sessions.get(rootId);
      // A child's last attachment can still be converting when native cleanup ends.
      // Commit its terminal activity after all earlier session updates are delivered.
      if (record) record.outputTail = record.outputTail.then(finish);
      else finish();
    });
    agent.ctx.on('agent/status', ({ agent: current, status }) => {
      if (current !== agent) return;
      if (status === 'running') { cancelled.delete(agent.id); startChild(); }
      else {
        // A managed activation can idle while its descendants run. It ends at
        // subagent/end, after the final parent notice; a later resume has a new Agent.
        void finishRoot(agent).catch(error => ctx.logger.warn(`dsh: activity update failed: ${error.message}`));
      }
    });
    const sourceWait = message => {
      const source = message.source;
      if (source?.senderSessionId && ['agent-message', 'subagent-settled'].includes(source.kind)) return childKeys.get(source.senderSessionId);
      if (source?.kind === 'tool-jobs') return pendingJobs.get(agent.id);
    };
    agent.ctx.on('agent/inbox/inserted', ({ agent: current, message }) => {
      if (current !== agent) return;
      const key = sourceWait(message);
      if (key) { messageKeys.set(message.id, key); waits.handling(key); }
    });
    agent.ctx.on('agent/inbox/claimed', ({ agent: current, message }) => {
      if (current !== agent) return;
      const key = messageKeys.get(message.id) ?? sourceWait(message);
      messageKeys.delete(message.id);
      if (key) waits.handling(key);
      if (!parent && !sessions.get(rootId)?.inflight && ![...waits.items.values()].some(w => w.sessionId === agent.id && w.state === 'handling')) {
        const key = `autonomous:${agent.id}:${message.id}`;
        waits.start(agent.id, key, { kind: 'task', title: 'DeepSeek 自主继续', autonomous: true }, () => agent.cancel({ kind: 'user' }));
        waits.handling(key);
      }
    });
    agent.ctx.on('agent/disposed', ({ agent: current }) => {
      if (current !== agent) return;
      if (attached.get(agent.id) === agent) {
        attached.delete(agent.id); roots.delete(agent.id); pendingJobs.delete(agent.id); childControllers.delete(agent.id);
      }
    });
  };

  api.initialize = async params => {
    const result = await native.initialize(params);
    result.agentInfo = { name: 'dsh', title: 'DeepSeek Harness', version: '1.0.0' };
    result.agentCapabilities.loadSession = true;
    result.agentCapabilities.sessionCapabilities.systemPrompt = {};
    result.agentCapabilities._meta = { coda: { waits: {} } };
    result._meta = { steering: { supported: true } };
    return result;
  };
  for (const name of ['newSession', 'resumeSession']) api[name] = async (params, signal) => {
    let record;
    try {
      if (name === 'newSession') await checkAuth('deepseek-official');
      const result = await native[name](params, signal);
      record = get(result.sessionId ?? params.sessionId);
      await checkAuth(record.modelControl.snapshot()?.provider);
      const instructions = params._meta?.[instructionKey] ?? '';
      await applyInstructions(record.agent, instructions, signal);
      attach(record.agent, record.agent.id);
      // Native updates retain their delivery barrier, with richer standard presentation.
      const notify = record.notify;
      record.notify = params => notify({ ...params, update: toolPresentation(params.update) });
      const modes = modeState(record);
      const title = ctx.get('sessionTitle')?.get(record.agent.session)?.title;
      if (title) emitUpdate(record.agent.id, { sessionUpdate: 'session_info_update', title });
      return { ...result, ...(modes ? { modes } : {}) };
    } catch (error) {
      if (record) { await record.close('Coda session initialization failed'); sessions.delete(record.agent.id); }
      throw authError(error, RequestError);
    }
  };
  api.cancel = params => {
    cancelled.add(params.sessionId); wire.cancelRequests(params.sessionId);
    return native.cancel(params);
  };
  api.closeSession = params => {
    wire.cancelRequests(params.sessionId);
    return native.closeSession(params);
  };

  ctx.on('session/event', (session, event) => {
    const agent = attached.get(session.id);
    if (!agent || agent.session !== session) return;
    const record = sessions.get(roots.get(agent.id));
    if (!record) return;
    const { type, data } = event;
    if (type === 'request/header' && agent !== record.agent) {
      const model = data.header.config.model;
      if (typeof model === 'string' && model.length <= 200) waits.update(childKeys.get(agent.id), { model });
    }
    if (type === 'job/registered') {
      waits.start(session.id, `job:${data.jobId}`, { kind: 'task', title: data.label.slice(0, 500),
        ...(data.toolCall?.rootCallId ? { toolCallId: data.toolCall.rootCallId } : {}) }, () => ctx.get('jobs').kill(data.jobId, session.id, 'Coda 停止'));
    } else if (type === 'job/settled') {
      const key = `job:${data.jobId}`;
      pendingJobs.set(session.id, key);
      // The registry synchronously delivers tool-jobs' completion notice after this log
      // event. Its inbox insertion must claim handling before the terminal notification.
      queueMicrotask(() => {
        waits.finish(key, { completed: 'done', killed: 'cancelled', failed: 'failed' }[data.status]);
        if (pendingJobs.get(session.id) === key) pendingJobs.delete(session.id);
      });
    }
    // Child updates join the root's existing delivery barrier. Their registration is already
    // on the wire, so Coda recognizes childSessionId before it sees these updates.
    record.outputTail = record.outputTail.then(async () => {
      if (agent !== record.agent && !waitsEnabled()) return;
      if (agent !== record.agent) {
        if (type === 'assistant/message') for (const update of await assistantUpdates(ctx, session, event)) emitUpdate(session.id, update);
        else if (type === 'tool/call') emitUpdate(session.id, toolCallUpdate(event));
        else if (type === 'tool/result') emitUpdate(session.id, await toolResultUpdate(ctx, event));
      }
      if (type === 'session/title') emitUpdate(session.id, { sessionUpdate: 'session_info_update', title: data.title });
      else if (type === 'todo/write') emitUpdate(session.id, { sessionUpdate: 'plan', entries: data.todos.map(todo => ({ ...todo, priority: 'medium' })) });
      else if (wire.clientCapabilities.session?.compaction && ['compaction/start', 'compaction/end'].includes(type))
        emitUpdate(session.id, { sessionUpdate: 'compaction_update', compactionId: data.compactionId,
          status: type === 'compaction/start' ? 'in_progress' : data.error ? 'failed' : 'completed', ...(data.error ? { error: data.error } : {}) });
    }).catch(error => { if (record.inflight) record.inflight.outputError ??= error; });
  });

  ctx.on('approval/request', async (request, next) => {
    const agent = attached.get(request.agent?.id);
    if (agent !== request.agent) return next();
    const record = get(roots.get(agent.id));
    if (agent !== record.agent && !waitsEnabled()) return next();
    await record.drainUpdates();
    try {
      const result = await wire.request('session/request_permission', {
        sessionId: agent.id,
        toolCall: { toolCallId: request.callId ?? `approval-${Date.now()}`, title: request.displayReason?.zh ?? request.reason ?? request.toolName },
        options: [{ optionId: 'allow-once', name: '仅允许本次', kind: 'allow_once' }, { optionId: 'reject-once', name: '拒绝本次', kind: 'reject_once' }]
      }, request.signal);
      if (result?.outcome?.outcome === 'cancelled') return 'cancelled';
      return result?.outcome?.optionId === 'allow-once' ? 'allowed-once' : 'rejected';
    } catch { return 'cancelled'; }
  });
  ctx.on('user-questions/request', async (request, next) => {
    const agent = attached.get(request.agent?.id);
    if (agent !== request.agent) return next();
    if (agent.id !== roots.get(agent.id) && !waitsEnabled()) return next();
    if (!wire.clientCapabilities.elicitation?.form) throw new Error('客户端不支持交互表单');
    await get(roots.get(agent.id)).drainUpdates();
    const result = await wire.request('elicitation/create', { sessionId: agent.id, mode: 'form',
      message: request.questions.map(q => [q.question, q.detail].filter(Boolean).join('\n\n')).join('\n\n'), requestedSchema: questionForm(request.questions) }, request.signal);
    return questionAnswer(request.questions, result);
  });

  wire.bind(message => {
    const { method, params = {}, id } = message;
    if (['session/new', 'session/load', 'session/resume'].includes(method)) {
      try {
        const instructions = sessionInstructions(params.systemPrompt);
        const { systemPrompt, ...rest } = params;
        message.params = { ...rest, _meta: { ...rest._meta, [instructionKey]: instructions } };
        if (method === 'session/load') message.method = 'session/resume';
      } catch (error) { wire.send({ id, error: { code: -32602, message: error.message } }); return true; }
      return false;
    }
    if (!['_session/steering', '_coda/wait/stop', 'session/set_mode', 'session/set_model'].includes(method)) return false;
    const respond = async () => {
      if (method === '_coda/wait/stop') { await waits.stop(params.sessionId, params.waitId); return {}; }
      const record = get(params.sessionId);
      if (method === '_session/steering') {
        // Check and enqueue in one synchronous section: steer() itself wakes idle agents.
        if (!record.inflight || record.inflight.admissionController.signal.aborted || record.agent.status !== 'running')
          return { outcome: 'promptRequired', reason: 'noRunningTurn' };
        if (!Array.isArray(params.prompt) || !params.prompt.length || params.prompt.some(b => b.type !== 'text' || typeof b.text !== 'string'))
          throw invalid('插话只接受文本块');
        record.agent.steer(createUserMessage({ content: params.prompt, source: { kind: 'user' } }));
        return { outcome: 'injected' };
      }
      if (method === 'session/set_model') return native.setSessionConfigOption({ sessionId: params.sessionId, configId: 'model', value: params.modelId });
      const presets = record.agent.ctx.get('permissionPresets');
      if (!presets?.names.includes(params.modeId)) throw invalid(`未知审批模式：${params.modeId}`);
      presets.set(record.agent.session, params.modeId);
      emitUpdate(params.sessionId, { sessionUpdate: 'current_mode_update', currentModeId: presets.current(record.agent.session) });
      return {};
    };
    respond().then(result => wire.send({ id, result }), error => wire.send({ id, error: { code: typeof error.code === 'number' ? error.code : -32602, message: error.message } }));
    return true;
  });
}
