import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { resolvePolicy } from '../../../plugins/ultra/policy.mjs';
import { checkPlugin } from '../../../check/index.mjs';

const dir = fileURLToPath(new URL('../../../plugins/ultra/', import.meta.url));
const model = (id, overrides = {}) => ({ id, defaultEffort: 'medium', efforts: ['low', 'medium', 'high', 'max'],
  effortOrder: ['low', 'medium', 'high', 'max'], options: [{ id: 'service-tier', type: 'select', values: ['standard', 'priority'], defaultValue: 'standard' }], ...overrides });
const input = (overrides = {}) => ({ version: 1, phase: 'spawn', settings: {}, parent: { agent: 'codex', model: 'm1', effort: 'max', options: { 'service-tier': 'priority' } },
  catalog: [{ agent: 'codex', available: true, delegation: true, current: { model: 'm1' }, models: [model('m1'), model('m2')] },
    { agent: 'another', available: true, delegation: true, current: { model: 'a1' }, models: [model('a1', { defaultEffort: 'balanced', efforts: ['balanced'], effortOrder: ['balanced'], options: [] })] }],
  limits: { maxChildren: 10 }, request: {}, ...overrides });
const settings = values => Object.fromEntries(Object.entries(values).map(([key, value]) => [`ultra.${key}`, value]));

test('inherits the actual parent model, effort and speed without mutating its input', () => {
  const raw = input(), before = structuredClone(raw), result = resolvePolicy(raw);
  assert.deepEqual(result.target, raw.parent);
  assert.equal(result.source, 'inherited');
  assert.equal(result.constraints.maxChildren, 3);
  assert.deepEqual(raw, before);
});
test('turn policy provides parent/child instructions and respects the host limit', () => {
  const result = resolvePolicy(input({ phase: 'turn', limits: { maxChildren: 2 } }));
  assert.equal(result.constraints.maxChildren, 2);
  assert.match(result.instructions, /Coda spawn/);
  assert.match(result.delegation.childInstructions, /Do not create further child/);
  assert.equal(result.target, undefined);
});
test('candidates use numeric priority and cross-model defaults rather than parent effort or speed', () => {
  const result = resolvePolicy(input({ settings: settings({ candidates: { '02': { agent: 'codex', model: 'm1' }, '01': { agent: 'another', model: 'a1' } } }) }));
  assert.deepEqual(result.target, { agent: 'another', model: 'a1', effort: 'balanced' });
  assert.equal(result.source, 'preferred');
  assert.match(result.reasons[0], /01/);
});
test('unavailable candidates are skipped with a reason; fallback requires an explicit setting', () => {
  const candidates = { '01': { agent: 'missing', model: 'unknown' }, '02': { agent: 'codex', model: 'm2' } };
  const chosen = resolvePolicy(input({ settings: settings({ candidates }) }));
  assert.equal(chosen.target.model, 'm2');
  assert.match(chosen.reasons[0], /missing 不可用/);
  delete candidates['02'];
  assert.throws(() => resolvePolicy(input({ settings: settings({ candidates }) })), /没有可用/);
  assert.equal(resolvePolicy(input({ settings: settings({ candidates, fallbackToParent: true }) })).target.model, 'm1');
});
test('inherited effort is clamped within model order, explicit over-limit requests fail', () => {
  const config = settings({ effortLimits: { 'codex|m1': '<=medium' } });
  const result = resolvePolicy(input({ settings: config }));
  assert.equal(result.target.effort, 'medium');
  assert.equal(result.source, 'limited');
  assert.deepEqual(result.constraints.allowedEfforts, ['low', 'medium']);
  assert.throws(() => resolvePolicy(input({ settings: config, request: { effort: 'high' } })), /超出限制/);
});
test('unordered effort capabilities only support allowed sets, never an inferred upper bound', () => {
  const raw = input({ settings: settings({ effortLimits: { 'codex|m1': '<=high' } }) });
  delete raw.catalog[0].models[0].effortOrder;
  assert.throws(() => resolvePolicy(raw), /未明确报告/);
  raw.settings['ultra.effortLimits']['codex|m1'] = 'high';
  assert.equal(resolvePolicy(raw).target.effort, 'high');
});
test('unsupported effort, options, unavailable agents and malformed limits fail before execution', () => {
  assert.throws(() => resolvePolicy(input({ request: { effort: 'ultra' } })), /不支持推理/);
  assert.throws(() => resolvePolicy(input({ request: { options: { secret: 'value' } } })), /不支持模型选项/);
  assert.throws(() => resolvePolicy(input({ request: { options: { 'service-tier': 'unknown' } } })), /不支持值/);
  assert.throws(() => resolvePolicy(input({ settings: settings({ effortLimits: { '*': '<=high' } }) })), /须指定 Agent 和模型/);
  assert.throws(() => resolvePolicy(input({ settings: settings({ effortLimits: { 'codex|m1': 'low,missing' } }) })), /不支持的等级/);
  const raw = input(); raw.catalog[0].delegation = false;
  assert.throws(() => resolvePolicy(raw), /尚未支持/);
});
test('explicit requests must be an allowed candidate and retain candidate effort defaults', () => {
  const raw = input({ settings: settings({ candidates: { '01': { agent: 'codex', model: 'm2', effort: 'low' } } }), request: { model: 'm2' } });
  assert.equal(resolvePolicy(raw).target.effort, 'low');
  raw.request.model = 'm1';
  assert.throws(() => resolvePolicy(raw), /不在允许/);
  raw.settings['ultra.allowOtherModels'] = true;
  assert.equal(resolvePolicy(raw).target.model, 'm1');
});
test('requesting only an agent still follows the configured model priority', () => {
  const raw = input({ settings: settings({ candidates: { '01': { agent: 'codex', model: 'm2', effort: 'low' }, '02': { agent: 'codex', model: 'm1' } } }), request: { agent: 'codex' } });
  assert.equal(resolvePolicy(raw).target.model, 'm2');
  assert.equal(resolvePolicy(raw).target.effort, 'low');
});
test('an agent-only candidate permits its actual default model but not every model of that agent', () => {
  const raw = input({ settings: settings({ candidates: { '01': { agent: 'another' } } }), request: { agent: 'another', model: 'a1' } });
  assert.equal(resolvePolicy(raw).target.model, 'a1');
  raw.request.model = 'a2';
  raw.catalog[1].models.push(model('a2'));
  assert.throws(() => resolvePolicy(raw), /不在允许/);
});
test('send keeps existing child choices when priorities change, but checks current hard limits', () => {
  const raw = input({ phase: 'send', request: { agent: 'codex', model: 'm2', effort: 'high', options: { 'service-tier': 'standard' } },
    settings: settings({ candidates: { '01': { agent: 'another', model: 'a1' } } }) });
  assert.deepEqual(resolvePolicy(raw).target, raw.request);
  raw.settings['ultra.effortLimits'] = { 'codex|m2': '<=medium' };
  assert.throws(() => resolvePolicy(raw), /超出限制/);
});
test('a model-owned default stays implicit in an inherited or continuing configuration', () => {
  const raw = input({ parent: { agent: 'codex', model: 'm1' } });
  assert.deepEqual(resolvePolicy(raw).target, raw.parent);
  raw.phase = 'send';
  raw.request = { agent: 'codex', model: 'm2' };
  assert.deepEqual(resolvePolicy(raw).target, raw.request);
});
test('missing target-model capability data is not replaced with another model capabilities', () => {
  const raw = input({ settings: settings({ candidates: { '01': { agent: 'codex', model: 'm2' } } }) });
  raw.catalog[0].models[1] = { id: 'm2' };
  assert.throws(() => resolvePolicy(raw), /没有报告配置能力/);
});
test('invalid priority, caps and cross-vendor option inheritance are rejected or isolated', () => {
  assert.throws(() => resolvePolicy(input({ settings: settings({ candidates: { '1': { agent: 'codex' } } }) })), /01–99/);
  assert.throws(() => resolvePolicy(input({ settings: settings({ maxChildren: 0 }) })), /1–10/);
  const raw = input({ settings: settings({ candidates: { '01': { agent: 'another', model: 'a1', options: { 'service-tier': 'priority' } } } }) });
  assert.throws(() => resolvePolicy(raw), /不支持模型选项/);
});
test('policy command has a JSON stdin/stdout contract and fails malformed input without a result', () => {
  const output = execFileSync(process.execPath, [join(dir, 'policy.mjs')], { input: JSON.stringify(input()), encoding: 'utf8' });
  assert.deepEqual(JSON.parse(output).target, input().parent);
  const bad = spawnSync(process.execPath, [join(dir, 'policy.mjs')], { input: '{invalid', encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.equal(bad.stdout, '');
  assert.ok(bad.stderr);
});
test('manifest checker accepts the installed policy and rejects malformed declarations', async t => {
  assert.deepEqual((await checkPlugin(dir, { manifestOnly: true })).report.failures, []);
  const temp = mkdtempSync(join(tmpdir(), 'coda-policy-manifest-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  manifest.contributes.sessionPolicies[0].enabledSetting = 'ultra.maxChildren';
  writeFileSync(join(temp, 'package.json'), JSON.stringify(manifest));
  assert.ok((await checkPlugin(temp, { manifestOnly: true })).report.failures.some(f => f.rule === 'manifest.sessionPolicies'));
});
