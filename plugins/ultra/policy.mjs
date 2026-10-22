// Session policy v1. Pure resolution lives here; Coda owns execution, quotas, request identity and actual-value checks.
import { pathToFileURL } from 'node:url';

export const instructions = `Ultra collaboration is active for this turn. Proactively delegate independent work to Coda child sessions when doing so saves time or improves quality. Use Coda spawn, send, status and cancel; Coda owns model selection and limits. Omit agent, model and effort to use the configured preferences. Give each child a self-contained task with the goal, relevant facts, paths, constraints, completion criteria and expected output. Assign disjoint files for shared work. A new worktree starts at the current commit and does not include uncommitted edits. Dispatch independent work concurrently. Integrate and verify the results yourself. Continue useful work while children run. Results arrive automatically; do not poll or wait. If nothing remains to do until a result arrives, end the current turn. Respect the configured concurrency limit and reuse suitable children with send. Do not use vendor-native subagent tools. Simple tasks do not require delegation.`;
export const childInstructions = `You are a Coda child session. Complete the assigned task within its scope, report changed paths, validation results and unresolved issues to the parent. Do not create further child sessions or use vendor-native subagent tools. Coda delivers your result automatically. Keep the execution configuration assigned by the parent; do not change model, reasoning effort or model options to bypass its policy.`;

const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = message => { throw new Error(`Ultra：${message}`); };
const check = (condition, message) => { if (!condition) fail(message); };
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const own = (obj, key) => Object.hasOwn(obj, key);
const sameModel = (a, b) => a.agent === b.agent && a.model === b.model;

function preferences(raw = {}) {
  check(plain(raw), '设置须为对象');
  const read = (key, fallback) => raw[`ultra.${key}`] ?? fallback;
  const candidates = read('candidates', {}), limits = read('effortLimits', {}), maxChildren = read('maxChildren', 3);
  check(plain(candidates), '子 Agent 候选顺序须为表格');
  check(Number.isInteger(maxChildren) && maxChildren >= 1 && maxChildren <= 10, '并发子 Agent 数须在 1–10 之间');
  check(plain(limits), '推理限制须为表格');
  for (const [key, value] of Object.entries(limits)) {
    check(/^[a-z][a-z0-9-]*\|[^|\s]+$/.test(key), `推理限制「${key}」须指定 Agent 和模型`);
    check(nonempty(value), `推理限制「${key}」不能为空`);
  }
  const ordered = Object.entries(candidates).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => {
    check(/^(0[1-9]|[1-9][0-9])$/.test(key), `候选序号「${key}」须为 01–99`);
    check(plain(value) && nonempty(value.agent), `候选 ${key} 须指定 Agent`);
    for (const name of ['model', 'effort']) check(value[name] === undefined || nonempty(value[name]), `候选 ${key} 的 ${name} 无效`);
    check(value.options === undefined || plain(value.options), `候选 ${key} 的模型选项须为对象`);
    return { ...value, key };
  });
  const fallback = read('fallbackToParent', false), allowOther = read('allowOtherModels', false);
  check(typeof fallback === 'boolean' && typeof allowOther === 'boolean', '回退与候选外选择须为开或关');
  return { candidates: ordered, limits, maxChildren, fallback, allowOther };
}

function capabilities(catalog, agent, model) {
  const row = catalog.find(item => item.agent === agent);
  check(row && row.available !== false, `Agent ${agent} 不可用`);
  check(row.delegation === true, `Agent ${agent} 尚未支持受约束的 Coda 委派`);
  const chosen = model ?? row.current?.model ?? row.defaultModel;
  check(nonempty(chosen), `Agent ${agent} 没有报告默认模型`);
  const spec = row.models?.find(item => item.id === chosen);
  check(spec, `模型 ${agent}/${chosen} 不可用`);
  check(Array.isArray(spec.efforts) && Array.isArray(spec.options), `模型 ${agent}/${chosen} 没有报告配置能力`);
  check(spec.efforts.every(nonempty), `模型 ${agent}/${chosen} 的推理等级无效`);
  if (spec.effortOrder !== undefined) check(Array.isArray(spec.effortOrder)
    && new Set(spec.effortOrder).size === spec.effortOrder.length
    && spec.effortOrder.length === spec.efforts.length
    && spec.effortOrder.every(id => spec.efforts.includes(id)), `模型 ${agent}/${chosen} 的推理顺序无效`);
  return { ...spec, agent, model: chosen };
}

function allowedEfforts(spec, raw) {
  if (raw === undefined) return spec.efforts;
  const value = raw.trim();
  if (value.startsWith('<=')) {
    const upper = value.slice(2).trim();
    check(spec.effortOrder?.includes(upper), `${spec.agent}/${spec.model} 未明确报告上限 ${upper} 的等级顺序；请使用允许集合`);
    return spec.effortOrder.slice(0, spec.effortOrder.indexOf(upper) + 1);
  }
  const requested = value.split(',').map(s => s.trim());
  check(requested.length && requested.every(nonempty) && new Set(requested).size === requested.length,
    `${spec.agent}/${spec.model} 的允许集合须为不重复的逗号分隔等级`);
  check(requested.every(id => spec.efforts.includes(id)), `${spec.agent}/${spec.model} 的推理限制包含不支持的等级：${requested.filter(id => !spec.efforts.includes(id)).join('、')}`);
  return requested;
}

function modelOptions(spec, values, includeDefaults = true) {
  const result = includeDefaults ? Object.fromEntries(spec.options.filter(item => own(item, 'defaultValue')).map(item => [item.id, item.defaultValue])) : {};
  for (const [key, value] of Object.entries(values)) {
    const option = spec.options.find(item => item.id === key);
    check(option, `${spec.agent}/${spec.model} 不支持模型选项 ${key}`);
    check(option.type === 'boolean' ? typeof value === 'boolean' : option.values?.includes(value), `${key} 不支持值 ${String(value)}`);
    result[key] = value;
  }
  return result;
}

function resolveCandidate({ candidate, parent, request, catalog, prefs, explicit, continuing }) {
  const agent = request.agent ?? candidate.agent;
  const model = request.model ?? candidate.model ?? (agent === parent.agent ? parent.model : undefined);
  const spec = capabilities(catalog, agent, model);
  const same = sameModel(spec, parent), reasons = [];
  const limited = own(prefs.limits, `${agent}|${spec.model}`);
  const allowed = allowedEfforts(spec, prefs.limits[`${agent}|${spec.model}`]);
  let effort = continuing ? request.effort : request.effort ?? candidate.effort ?? (same ? parent.effort : spec.defaultEffort);
  // An unspecified effort is the target model's own default, never a label borrowed from another model.
  check(effort === undefined || spec.efforts.includes(effort), `${agent}/${spec.model} 不支持推理等级 ${effort}`);
  let adjusted = false;
  if (limited && effort === undefined && spec.defaultEffort !== undefined) effort = spec.defaultEffort;
  if (limited && !allowed.includes(effort ?? spec.defaultEffort)) {
    check(!own(request, 'effort') && !continuing, `请求的推理等级 ${effort ?? '默认'} 超出限制；允许：${allowed.join('、')}`);
    const replacement = spec.effortOrder?.filter(id => allowed.includes(id)).at(-1)
      ?? (allowed.includes(spec.defaultEffort) ? spec.defaultEffort : allowed.length === 1 ? allowed[0] : undefined);
    check(replacement !== undefined, `${agent}/${spec.model} 的默认推理等级不符合限制，且没有明确顺序；请在候选中指定允许的等级`);
    reasons.push(`推理等级由 ${effort ?? '默认'} 调整为 ${replacement}，以满足模型限制`);
    effort = replacement;
    adjusted = true;
  }
  const options = modelOptions(spec, { ...(same && !continuing ? parent.options : {}), ...candidate.options, ...request.options }, !same && !continuing);
  const target = { agent, model: spec.model, ...(effort !== undefined ? { effort } : {}), ...(Object.keys(options).length ? { options } : {}) };
  const source = adjusted ? 'limited' : explicit || continuing ? 'explicit' : candidate.key ? 'preferred' : 'inherited';
  reasons.unshift(source === 'preferred' ? `采用第 ${candidate.key} 个候选` : source === 'inherited' ? '继承父轮次实际执行配置'
    : continuing ? '保留子会话已有执行配置并检查当前限制' : '使用指定候选配置');
  return { target, source, reasons, constraints: { maxChildren: prefs.maxChildren, allowedAgents: [agent], allowedModels: [spec.model],
    ...(limited ? { allowedEfforts: allowed } : {}) } };
}

export function resolvePolicy(input) {
  check(plain(input) && input.version === 1, '不支持的会话策略协议版本');
  check(['turn', 'spawn', 'send'].includes(input.phase), '不支持的策略阶段');
  const prefs = preferences(input.settings);
  const globalMax = input.limits?.maxChildren;
  if (globalMax !== undefined) {
    check(Number.isInteger(globalMax) && globalMax > 0, 'Coda 并发上限无效');
    prefs.maxChildren = Math.min(prefs.maxChildren, globalMax);
  }
  const context = { version: 1, enabled: true, instructions,
    delegation: { active: true, role: 'parent', instructions, childInstructions },
    constraints: { maxChildren: prefs.maxChildren }, source: 'inherited', reasons: [] };
  if (input.phase === 'turn') return context;
  const { parent, request = {}, catalog = [] } = input;
  check(plain(parent) && nonempty(parent.agent) && nonempty(parent.model), '父轮次没有实际 Agent 与模型快照');
  check(plain(request) && Array.isArray(catalog), '派生意图或模型目录无效');
  for (const key of ['agent', 'model', 'effort']) check(!own(request, key) || nonempty(request[key]), `请求的 ${key} 无效`);
  check(request.options === undefined || plain(request.options), '请求的模型选项须为对象');
  const continuing = input.phase === 'send';
  const base = { agent: parent.agent, model: parent.model };
  const list = prefs.candidates.length ? prefs.candidates : [base];
  const explicit = own(request, 'agent') || own(request, 'model');
  if (continuing) {
    check(nonempty(request.agent) && nonempty(request.model), '续跑缺少子会话执行快照');
    return { ...context, ...resolveCandidate({ candidate: {}, parent, request, catalog, prefs, explicit: true, continuing: true }) };
  }
  if (explicit) {
    const agent = request.agent ?? parent.agent;
    const defaultModel = agent === parent.agent ? parent.model : catalog.find(item => item.agent === agent)?.current?.model
      ?? catalog.find(item => item.agent === agent)?.defaultModel;
    const matches = list.filter(item => item.agent === agent && (request.model === undefined
      || (item.model ?? defaultModel) === request.model));
    if (prefs.fallback && agent === parent.agent && (request.model === undefined || request.model === parent.model)) matches.push(base);
    if (!matches.length && prefs.allowOther) matches.push({ agent, ...(request.model === undefined ? {} : { model: request.model }) });
    check(matches.length, '指定模型不在允许的候选中；省略 Agent 和模型可按偏好自动选择');
    const failures = [];
    for (const candidate of matches) {
      try { return { ...context, ...resolveCandidate({ candidate, parent, request, catalog, prefs, explicit: true }) }; }
      catch (error) { failures.push(error.message); }
    }
    fail(failures.join('；'));
  }
  const reasons = [];
  const candidates = prefs.candidates.length && prefs.fallback ? [...list, base] : list;
  for (const candidate of candidates) {
    try {
      const result = resolveCandidate({ candidate, parent, request, catalog, prefs, explicit: false });
      const skipped = reasons.length > 37 ? [...reasons.slice(0, 37), `另有 ${reasons.length - 37} 个候选未满足约束`] : reasons;
      return { ...context, ...result, reasons: [...skipped, ...result.reasons] };
    } catch (error) { reasons.push(`${candidate.key ? `候选 ${candidate.key}` : '父配置'}：${error.message}`); }
  }
  fail(`没有可用的子 Agent 配置。${reasons.join('；')}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    let input = '';
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) {
      input += chunk;
      check(Buffer.byteLength(input) <= 1024 * 1024, '策略输入超过 1 MiB');
    }
    process.stdout.write(`${JSON.stringify(resolvePolicy(JSON.parse(input)))}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
