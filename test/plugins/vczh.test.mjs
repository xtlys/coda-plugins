import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { panelItems } from '../../check/panel.mjs';
import { base, config, fingerprint, hash, init, json, managed, save } from '../../plugins/vczh/scripts/store.mjs';
import { builtinPrompts, enablePrompt, prompts, putPrompt } from '../../plugins/vczh/scripts/prompts.mjs';
import { documents, freshness, putDocument } from '../../plugins/vczh/scripts/knowledge.mjs';
import { advance, bind, check, record, revise, start, task } from '../../plugins/vczh/scripts/tasks.mjs';
import { panel } from '../../plugins/vczh/scripts/panel.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const plugin = join(root, 'plugins/vczh'), cli = join(plugin, 'scripts/cli.mjs');
function fixture(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'vczh-test-'))), repo = join(dir, 'repo'), state = join(dir, 'state');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // Borrow existing commit objects, without configuring a Git identity or writing to the source repository.
  execFileSync('git', ['clone', '-q', '--shared', '--no-checkout', root, repo]);
  execFileSync('git', ['-C', repo, 'read-tree', '--empty']);
  mkdirSync(state); writeFileSync(join(repo, 'source.js'), 'export const answer = 42;\n');
  const oldState = process.env.CODA_PLUGIN_STATE; process.env.CODA_PLUGIN_STATE = state;
  t.after(() => { if (oldState === undefined) delete process.env.CODA_PLUGIN_STATE; else process.env.CODA_PLUGIN_STATE = oldState; });
  init(repo);
  return { dir, repo, state, run(args, options = {}) {
    return spawnSync(process.execPath, [cli, ...args], { cwd: repo, encoding: 'utf8', env: { ...process.env, CODA_PLUGIN_STATE: state }, ...options });
  } };
}
const pass = (r, id) => check(r, id, [process.execPath, '-e', 'process.stdout.write("ok")']).id;
function finish(r, id, receipt) {
  const before = task(r, id); record(r, id, receipt); return advance(r, id, before.phase, before.revision);
}
function implementation(r, t) {
  finish(r, t.id, { summary: '功能验收已定义', outcome: 'specified', checks: [pass(r, t.id)] });
  return finish(r, t.id, { summary: '复用现有逻辑', candidates: [{ id: 'a', title: '修复权威实现', rationale: '行为入口唯一', verification: '运行现有用例' }], selected: 'a' });
}
function doc(t, extra = {}) { return { id: 'contract', title: '模块契约', summary: '模块输入输出', body: '# 模块契约\n\nanswer 是 42。', status: 'confirmed', sources: [{ path: 'source.js' }], taskIds: [t.id], ...extra }; }

test('vczh initializes without replacing project instructions and can be rerun', t => {
  const f = fixture(t); writeFileSync(join(f.repo, 'AGENTS.md'), 'project-owned');
  const first = config(f.repo); init(f.repo);
  assert.deepEqual(config(f.repo), first);
  assert.equal(readFileSync(join(f.repo, 'AGENTS.md'), 'utf8'), 'project-owned');
  assert.equal(f.run(['init']).status, 0);
  const overview = panel(f.state); assert.equal(overview.items[1].items[0].value, '1');
});

test('project prompts preserve built-ins and require paired examples', t => {
  const f = fixture(t), original = builtinPrompts()[0];
  assert.throws(() => putPrompt(f.repo, original), /内置规范/);
  const custom = { ...original, id: 'project-errors', scope: 'project', title: '项目错误边界' };
  assert.throws(() => putPrompt(f.repo, { ...custom, examples: [] }), /正反示例/);
  putPrompt(f.repo, custom);
  assert.equal(prompts(f.repo).find(p => p.id === custom.id).enabled, false);
  enablePrompt(f.repo, custom.id, true); assert.ok(prompts(f.repo).find(p => p.id === custom.id).enabled);
  enablePrompt(f.repo, 'general', false); assert.equal(prompts(f.repo).find(p => p.id === 'general').enabled, false);
  assert.deepEqual(builtinPrompts()[0], original);
});

test('actual check results and current code are required to advance', t => {
  const { repo: r } = fixture(t), job = start(r, '实现', '验收描述'); implementation(r, job);
  const failed = check(r, job.id, [process.execPath, '-e', 'process.exit(7)']);
  assert.throws(() => record(r, job.id, { summary: '不能当作成功', checks: [failed.id] }), /未通过/);
  const missing = check(r, job.id, ['vczh-no-such-program']);
  assert.throws(() => record(r, job.id, { summary: '不能当作成功', checks: [missing.id] }), /未正常完成/);
  const checkId = pass(r, job.id); writeFileSync(join(r, 'source.js'), 'changed');
  assert.throws(() => record(r, job.id, { summary: '旧证据', checks: [checkId] }), /过期/);
  const next = finish(r, job.id, { summary: '新验证', checks: [pass(r, job.id)] }); assert.equal(next.phase, 'review');
  assert.equal(advance(r, job.id, 'implementation', next.revision - 1).phase, 'review', 'gate retry is idempotent');
});

test('review loop, invalidation, refinement, evidence retention, and completion', t => {
  const { repo: r } = fixture(t), job = start(r, '完整任务', '实现、评审与知识'); implementation(r, job);
  finish(r, job.id, { summary: '实现完成', checks: [pass(r, job.id)] });
  assert.equal(finish(r, job.id, { summary: '边界遗漏', decision: 'changes', reviewer: 'self', findings: ['补充边界处理'] }).phase, 'implementation');
  finish(r, job.id, { summary: '修正完成', checks: [pass(r, job.id)] });
  finish(r, job.id, { summary: '通过', decision: 'approve', reviewer: 'self', findings: [] });
  writeFileSync(join(r, 'source.js'), 'changed after review');
  assert.throws(() => record(r, job.id, { summary: '无新增', documents: [], noKnowledgeReason: '只修注释' }), /评审后代码/);
  const before = task(r, job.id); revise(r, job.id, '评审后源文件更新');
  assert.equal(advance(r, job.id, before.phase, before.revision).phase, 'implementation');
  finish(r, job.id, { summary: '重新实现', checks: [pass(r, job.id)] });
  finish(r, job.id, { summary: '通过', decision: 'approve', reviewer: 'self', findings: [] });
  putDocument(r, 'knowledge', doc(job));
  finish(r, job.id, { summary: '已沉淀', documents: [{ kind: 'knowledge', id: 'contract' }] });
  const done = finish(r, job.id, { summary: '本地完成', mode: 'local' });
  assert.equal(done.phase, 'done'); assert.ok(done.history.some(h => h.decision === 'changes'));
  assert.ok(done.history.some(h => h.action === 'revise'));
  assert.ok(existsSync(managed(r, `TaskLogs/${job.id}/evidence-0.json`)));
});

test('review retry limit stops without losing recorded findings', t => {
  const { repo: r } = fixture(t), job = start(r, '反复修改', '检查循环');
  save(managed(r, 'project.json'), { ...config(r), maxReviewRounds: 1 }); implementation(r, job);
  finish(r, job.id, { summary: '完成', checks: [pass(r, job.id)] });
  record(r, job.id, { summary: '仍有问题', decision: 'changes', reviewer: 'self', findings: ['具体缺陷'] });
  assert.throws(() => advance(r, job.id, 'review', task(r, job.id).revision), /上限/);
  assert.equal(task(r, job.id).phase, 'review');
  save(managed(r, 'project.json'), { ...config(r), maxReviewRounds: 3 });
  assert.equal(advance(r, job.id, 'review', task(r, job.id).revision).phase, 'implementation');
});

test('knowledge tracks source changes, validates paths, and counts unique tasks', t => {
  const { repo: r } = fixture(t), a = start(r, 'a', 'a'), b = start(r, 'b', 'b');
  putDocument(r, 'learning', doc(a)); putDocument(r, 'learning', doc(a));
  assert.equal(documents(r, 'learning')[0].taskIds.length, 1);
  putDocument(r, 'learning', doc(b)); const current = documents(r, 'learning')[0];
  assert.equal(current.taskIds.length, 2); assert.equal(freshness(r, current), 'current');
  writeFileSync(join(r, 'source.js'), 'new behavior'); assert.equal(freshness(r, current), 'stale');
  rmSync(join(r, 'source.js')); assert.equal(freshness(r, current), 'stale');
  assert.throws(() => putDocument(r, 'knowledge', doc(a, { sources: [{ path: '../outside' }] })), /相对路径/);
  assert.throws(() => putDocument(r, 'knowledge', doc(a, { sources: [{ path: '/etc/hosts' }] })), /相对路径/);
  symlinkSync('/etc/hosts', join(r, 'source.js'));
  assert.throws(() => putDocument(r, 'knowledge', doc(a)), /符号链接/);
  assert.ok(readFileSync(managed(r, 'Learning/Index.md'), 'utf8').includes('contract.md'));
});

test('managed directory symlinks cannot write outside the project', t => {
  const f = fixture(t), outside = join(f.dir, 'outside'); mkdirSync(outside);
  rmSync(join(f.repo, '.github'), { recursive: true }); symlinkSync(outside, join(f.repo, '.github'));
  assert.throws(() => init(f.repo), /符号链接/); assert.deepEqual(existsSync(join(outside, 'vczh')), false);
});

test('code fingerprint covers source, new files, executable modes and prompt changes, not task output', t => {
  const { repo: r } = fixture(t), before = fingerprint(r), job = start(r, '任务', '描述');
  pass(r, job.id); assert.equal(fingerprint(r), before);
  enablePrompt(r, 'cpp', true); assert.notEqual(fingerprint(r), before);
  const enabled = fingerprint(r); writeFileSync(join(r, 'new.js'), 'new input'); assert.notEqual(fingerprint(r), enabled);
  symlinkSync('new.js', join(r, 'link.js')); assert.doesNotThrow(() => fingerprint(r));
});

test('all panel pages, actions and large datasets fit Coda limits', t => {
  const f = fixture(t), job = start(f.repo, '面板', '展示'), original = builtinPrompts()[0];
  for (let i = 0; i < 12; i++) {
    putDocument(f.repo, 'knowledge', doc(job, { id: `doc-${i}`, body: '段落内容。'.repeat(2000) }));
    putPrompt(f.repo, { ...original, id: `custom-${i}`, scope: 'project' });
  }
  assert.equal(f.run(['init']).status, 0);
  const key = hash(f.repo), spec = { actions: { browse: {} } };
  const queue = [{ view: 'overview' }, { view: 'builtin', id: 'general' }, { view: 'builtin', id: 'cpp' }, { view: 'project', key, kind: 'knowledge' }, { view: 'project', key, kind: 'prompts' }];
  const seen = new Set();
  while (queue.length) {
    const view = queue.shift(), token = JSON.stringify(view); if (seen.has(token)) continue; seen.add(token);
    const output = panel(f.state, view); assert.doesNotThrow(() => panelItems(JSON.stringify(output), spec));
    for (const item of output.items.flatMap(x => x.type === 'card' ? x.items : [x])) if (item.type === 'button') queue.push(item.args);
  }
  assert.ok(seen.size > 30);
  const action = spawnSync(process.execPath, [join(plugin, 'scripts/panel.mjs'), '--browse'], { env: { ...process.env, CODA_PLUGIN_STATE: f.state, CODA_PANEL_ARGS: JSON.stringify({ view: 'builtin', id: 'cpp' }) } });
  assert.equal(action.status, 0); assert.equal(json(join(f.state, 'view.json')).id, 'cpp');
});

test('workflow runner resumes state, rejects run takeover, and errors on absent evidence', t => {
  const f = fixture(t), job = start(f.repo, '流程', '运行');
  bind(f.repo, job.id, 'run-1'); assert.throws(() => bind(f.repo, job.id, 'run-2'), /接管/);
  const output = join(f.dir, 'output'), summary = join(f.dir, 'summary');
  const env = { ...process.env, VCZH_ROOT: f.repo, VCZH_TASK: job.id, VCZH_RUN: 'run-1', GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary, CODA_PLUGIN_STATE: f.state };
  const run = (action, extra = {}) => spawnSync(process.execPath, [join(plugin, 'scripts/workflow.mjs'), action], { cwd: f.dir, env: { ...env, ...extra }, encoding: 'utf8' });
  assert.equal(run('route').status, 0); assert.match(readFileSync(output, 'utf8'), /phase=repro/);
  assert.equal(run('advance', { VCZH_PHASE: 'repro', VCZH_REVISION: '0' }).status, 1);
  record(f.repo, job.id, { summary: '复现', outcome: 'specified', checks: [pass(f.repo, job.id)] });
  assert.equal(run('advance', { VCZH_PHASE: 'repro', VCZH_REVISION: '0' }).status, 0);
  assert.equal(task(f.repo, job.id).phase, 'proposal'); assert.equal(run('route').status, 0);
});

test('CLI supports conversation entry, authoring and real failed checks', t => {
  const f = fixture(t);
  for (const phase of ['', 'repro', 'proposal', 'implementation', 'review', 'refine', 'delivery', 'knowledge', 'prompts']) {
    const result = f.run(['protocol', ...(phase ? [phase] : [])]); assert.equal(result.status, 0, result.stderr);
  }
  const template = f.run(['prompt', 'template', 'errors']); assert.equal(template.status, 0);
  const input = join(f.dir, 'prompt.json'); writeFileSync(input, template.stdout);
  assert.equal(f.run(['prompt', 'put', '--file', input]).status, 0);
  assert.equal(f.run(['prompt', 'enable', 'errors']).status, 0);
  assert.match(f.run(['prompt', 'show', 'errors']).stdout, /应该怎样做/);
  const request = join(f.dir, 'request.md'); writeFileSync(request, '支持此功能');
  const created = f.run(['task', 'start', '--title', '真实 CLI', '--file', request]); assert.equal(created.status, 0);
  const id = JSON.parse(created.stdout).id;
  const failed = f.run(['check', id, '--', process.execPath, '-e', 'process.exit(3)']);
  assert.equal(failed.status, 1); assert.equal(JSON.parse(failed.stdout).exitCode, 3);
  assert.equal(f.run(['task', 'show', id]).status, 0);
});

test('multiple worktrees count as one project, with readable fallback after removal', t => {
  const f = fixture(t), other = join(f.dir, 'other');
  execFileSync('git', ['-C', f.repo, 'worktree', 'add', '--detach', '--no-checkout', other, 'HEAD'], { stdio: 'ignore' });
  execFileSync('git', ['-C', other, 'read-tree', '--empty']);
  init(other); assert.equal(config(other).projectId, config(f.repo).projectId);
  f.run(['init']); f.run(['init'], { cwd: other });
  let overview = panel(f.state); assert.equal(overview.items[1].items[0].value, '1');
  rmSync(other, { force: true, recursive: true });
  overview = panel(f.state); assert.equal(overview.items[1].items[1].value, '0');
  rmSync(f.repo, { force: true, recursive: true });
  overview = panel(f.state); assert.equal(overview.items[1].items[1].value, '1');
  assert.doesNotThrow(() => panelItems(JSON.stringify(overview), { actions: { browse: {} } }));
});

test('final archive refuses changed code and uncommitted PR records', t => {
  const f = fixture(t), job = start(f.repo, 'PR 交付', '完整证据', 'pull-request'); implementation(f.repo, job);
  finish(f.repo, job.id, { summary: '实现', checks: [pass(f.repo, job.id)] });
  finish(f.repo, job.id, { summary: '通过', decision: 'approve', reviewer: 'self', findings: [] });
  finish(f.repo, job.id, { summary: '重复已知内容', documents: [], noKnowledgeReason: '本次无新增知识' });
  assert.throws(() => record(f.repo, job.id, { summary: 'PR', mode: 'pull-request', pr: '123' }), /完整 PR 地址/);
  finish(f.repo, job.id, { summary: 'PR', mode: 'pull-request', pr: 'https://github.com/example/repo/pull/1' });
  const run = () => spawnSync(process.execPath, [join(plugin, 'scripts/workflow.mjs'), 'archive'], { encoding: 'utf8', env: {
    ...process.env, VCZH_ROOT: f.repo, VCZH_TASK: job.id, VCZH_RUN: 'archive-run', GITHUB_OUTPUT: join(f.dir, 'out')
  } });
  let result = run(); assert.equal(result.status, 1); assert.match(result.stderr, /最终知识与任务记录/);
  writeFileSync(join(f.repo, 'source.js'), 'post-delivery change');
  result = run(); assert.equal(result.status, 1); assert.match(result.stderr, /归档前代码变化/);
  assert.equal(revise(f.repo, job.id, '归档前变化').phase, 'implementation');
});
