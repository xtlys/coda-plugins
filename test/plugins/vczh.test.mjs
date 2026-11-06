import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { panelItems } from '../../check/panel.mjs';
import { config, hash, init, inside, json, managed, save } from '../../plugins/vczh/scripts/store.mjs';
import { builtinPrompts, enablePrompt, manifest, prompts, promptTemplate, putPrompt, renderPrompt, sourceText, validatePrompt } from '../../plugins/vczh/scripts/prompts.mjs';
import { backups, documents, legacyDocuments, remember } from '../../plugins/vczh/scripts/knowledge.mjs';
import { bindRequest, finishRequest, getRequest, route, startRequest } from '../../plugins/vczh/scripts/requests.mjs';
import { protocol } from '../../plugins/vczh/scripts/protocol.mjs';
import { panel } from '../../plugins/vczh/scripts/panel.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const plugin = join(root, 'plugins/vczh'), cli = join(plugin, 'scripts/cli.mjs');
function fixture(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'vczh-test-'))), repo = join(dir, 'repo'), state = join(dir, 'state');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
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
function write(root, path, content) { const file = inside(root, path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, content); }
const logPath = '.github/TaskLogs/Copilot_Investigate.md';
const investigation = '# !!!INVESTIGATE!!!\n\n# PROBLEM DESCRIPTION\nexact request\n\n# TEST [CONFIRMED]\nobserved\n\n# PROPOSALS\n- No.1 one [CONFIRMED]\n- No.2 two [DENIED]\n';

test('only general and C++ topic packs are distributed, with checked bodies and source provenance', () => {
  for (const file of manifest.files) assert.equal(hash(readFileSync(join(plugin, 'upstream', file.path))), file.sha256);
  const packs = builtinPrompts();
  assert.deepEqual(packs.map(p => p.id), ['general', 'cpp']);
  assert.deepEqual(packs.map(p => p.topics.length), [9, 8]);
  const audit = json(join(root, 'scripts/vczh/classification.json'));
  assert.deepEqual(Object.keys(audit.dimensions), ['general', 'cpp', 'vczh-libraries', 'toolchain']);
  assert.equal(audit.files.length, 13);
  for (const file of audit.files) {
    const coverage = Array(file.lineCount).fill(0);
    for (const span of file.spans) {
      const c = span.classification;
      assert.ok(audit.dimensions[c.dimension].topics[c.topic]);
      for (let n = span.start; n <= span.end; n++) coverage[n - 1]++;
      if (c.rule) {
        const s = packs.find(p => p.id === c.dimension).sections.find(s => s.id === c.rule);
        assert.equal(s.topic, c.topic);
        assert.ok(s.sources.some(f => f.path === file.path && f.start <= span.start && f.end >= span.end));
      }
    }
    assert.deepEqual(coverage, Array(file.lineCount).fill(1), file.path);
    assert.throws(() => sourceText(file.path), /未分发/);
    assert.equal(existsSync(join(plugin, 'upstream', file.path)), false);
  }
  for (const p of packs) {
    for (const s of p.sections) {
      assert.ok(renderPrompt(p, s.topic).includes(s.body));
      assert.equal(hash(s.body), s.sha256);
      assert.doesNotMatch(s.body, /Vlpp|GacUI|VCZH_|WString|Nullable<|Ptr<|SPIN_LOCK|ThreadPoolLite|RepeatingTaskExecutor|TaskQueue|IValue|vmake|msbuild|copilotBuild|copilotExecute|EMSCRIPTEN|wasm_/i);
    }
    const modified = structuredClone(p); modified.sections[0].body += 'altered';
    assert.throws(() => validatePrompt(modified, true), /指纹/);
  }
  for (const file of ['prompts/workflow.json', 'prompts/vczh-project.json', 'upstream/Scripts/copilotBuild.ps1', 'upstream/copilotInit.ps1']) assert.equal(existsSync(join(plugin, file)), false);
});

test('every executable protocol loads scoped instructions without bringing excluded conventions back', () => {
  for (const mode of ['ask', 'investigate', 'review', 'refine', 'kb', 'kb-refine', 'direct']) {
    const output = protocol(mode);
    for (const path of ['AGENTS.md', 'copilot-instructions.md', ...(mode === 'direct' ? [] : [`prompts/${mode}.prompt.md`])]) assert.ok(output.includes(sourceText(path)), `${mode}: ${path}`);
    assert.doesNotMatch(output, /GacUI|Vlpp|MSBuild|vmake|copilotBuild|copilotExecute|\.github\/Scripts|\.github\/Ubuntu|\.github\/Guidelines\/|prompt show (?:workflow|vczh-project)/);
    assert.match(output, /vczh prompt show general/);
  }
  assert.throws(() => protocol('implementation'), /未知原文协议/);
});

test('retained rules keep original conditions, exceptions and deliberately uncorrected statements', () => {
  const [general, cpp] = builtinPrompts();
  assert.match(general.sections.find(s => s.id === 'correctness-first').body, /Unless explicitly instructed/);
  assert.match(general.sections.find(s => s.id === 'upstream').body, /project is well covered by unit test/);
  assert.match(general.sections.find(s => s.id === 'interfaces').body, /stricker contract is allowed\/encouraged/);
  assert.match(general.sections.find(s => s.id === 'unstable-bugs').body, /consecutive 25 successful runs/);
  assert.match(cpp.sections.find(s => s.id === 'pimpl').body, /The only exception is forcing to hide platform dependend constructions/);
  assert.match(cpp.sections.find(s => s.id === 'raii').body, /If an exception is surely going to crash the app and nothing will recover from it/);
  assert.match(cpp.sections.find(s => s.id === 'modern').body, /up to C\+\+ 20/);
});

test('initialization preserves native and legacy documents and does not impose a review limit', t => {
  const f = fixture(t);
  write(f.repo, 'AGENTS.md', 'project instructions');
  write(f.repo, 'Project.md', 'build: node --test');
  write(f.repo, logPath, investigation);
  write(f.repo, '.github/KnowledgeBase/Index.md', '# Our index\n\n- [API](./KB_Project_Api.md)\n');
  write(f.repo, '.github/vczh/KnowledgeBase/old.md', '# Legacy\nretained');
  const before = config(f.repo); init(f.repo);
  assert.deepEqual(config(f.repo), before); assert.equal(before.maxReviewRounds, undefined);
  assert.equal(readFileSync(join(f.repo, 'AGENTS.md'), 'utf8'), 'project instructions');
  assert.equal(readFileSync(join(f.repo, 'Project.md'), 'utf8'), 'build: node --test');
  assert.equal(readFileSync(join(f.repo, logPath), 'utf8'), investigation);
  assert.equal(legacyDocuments(f.repo)[0].body, '# Legacy\nretained');
});

test('original keyword routing, all subcommands, and default file expansion are preserved', t => {
  const { repo } = fixture(t);
  write(repo, 'TODO_TASK.md', '## Task 1\nverbatim\n## REVIEW COMMENTS\n### keep [CLOSED]\n');
  for (const command of ['repro', 'continue', 'report']) {
    const r = route(repo, `investigate ${command} exact\ntext`);
    assert.equal(r.mode, 'investigate'); assert.equal(r.request, `# ${command[0].toUpperCase()}${command.slice(1)}\nexact\ntext`);
  }
  for (const command of ['topic', 'ask', 'draft', 'improve', 'execute']) {
    const r = route(repo, `kb ${command} content`); assert.equal(r.mode, 'kb'); assert.equal(r.command, command);
  }
  assert.equal(route(repo, 'kb refine').mode, 'kb-refine');
  assert.equal(route(repo, 'investigate').request, '');
  assert.equal(route(repo, 'refine').mode, 'refine');
  assert.equal(route(repo, 'ask what happened?').request, 'what happened?');
  assert.equal(route(repo, 'review').request, '<tagging REPO-ROOT/TODO_TASK.md>');
  assert.equal(route(repo, 'investigate repro').request, '# Repro\n' + readFileSync(join(repo, 'TODO_TASK.md'), 'utf8'));
  write(repo, 'task.md', 'different exact request\n');
  assert.equal(route(repo, 'investigate repro @task.md', { taskFile: 'task.md' }).request, '# Repro\ndifferent exact request\n');
  assert.equal(route(repo, 'investigate # Report\nmessage').request, '# Report\nmessage');
});

test('semantic fallbacks distinguish coding, research, and build/CI maintenance', t => {
  const { repo } = fixture(t);
  assert.equal(route(repo, '添加功能', { intent: 'coding' }).request, '# Repro\n添加功能');
  assert.equal(route(repo, '为什么这样设计', { intent: 'research' }).mode, 'ask');
  assert.equal(route(repo, '修复 CI 脚本', { intent: 'maintenance' }).mode, 'direct');
  assert.throws(() => route(repo, 'ambiguous'), /intent/);
  assert.throws(() => route(repo, 'investigate repro', { taskFile: '../outside' }), /相对路径/);
});

test('continuation, report and restart never clear the current investigation', t => {
  const { repo } = fixture(t); write(repo, logPath, investigation);
  for (let i = 0; i < 5; i++) {
    const r = startRequest(repo, i % 2 ? 'investigate report compare' : 'investigate continue correction');
    assert.equal(r.latest.includes('correction') || r.latest.includes('compare'), true);
    bindRequest(repo, r.id, `run-${i}`); bindRequest(repo, r.id, `run-${i}`);
    assert.equal(readFileSync(join(repo, logPath), 'utf8'), investigation);
    finishRequest(repo, r.id, `run-${i}`); finishRequest(repo, r.id, `run-${i}`);
    assert.equal(getRequest(repo, r.id).status, 'done');
  }
  assert.deepEqual(backups(repo, 10), [], 'Only the Repro protocol archives; starting Coda requests must not do it');
});

test('fixed task documents cannot be taken over by a simultaneous workflow', t => {
  const { repo } = fixture(t), a = startRequest(repo, 'investigate continue'), b = startRequest(repo, 'kb topic inspect');
  bindRequest(repo, a.id, 'a');
  assert.throws(() => bindRequest(repo, a.id, 'x'), /绑定/);
  assert.throws(() => bindRequest(repo, b.id, 'b'), /固定任务文档/);
  assert.throws(() => finishRequest(repo, a.id, 'b'), /只能完成/);
  finishRequest(repo, a.id, 'a'); assert.equal(bindRequest(repo, b.id, 'b').status, 'running');
});

test('remember preserves complete notes, resets the marker, orders backups and avoids timestamp collisions', t => {
  const { repo } = fixture(t), time = new Date('2026-11-07T00:00:00Z');
  assert.deepEqual(remember(repo, time), { archived: false });
  write(repo, logPath, investigation); const a = remember(repo, time);
  assert.equal(readFileSync(join(repo, a.path), 'utf8'), investigation);
  assert.equal(readFileSync(join(repo, logPath), 'utf8'), '# !!!INVESTIGATE!!!\n');
  write(repo, logPath, investigation + '# UPDATES\n## UPDATE\nuser correction'); const b = remember(repo, time);
  assert.notEqual(a.path, b.path); assert.equal(backups(repo, 2).length, 2);
  assert.ok(b.path > a.path); assert.ok(existsSync(join(repo, a.path)), 'refine chooses which redundant snapshot to remove');
});

test('native knowledge, indexes and counted learning work without JSON metadata', t => {
  const { repo } = fixture(t);
  const body = '# API contract\n\nUse `Example` for data.\n';
  write(repo, '.github/KnowledgeBase/KB_Project_Api.md', body);
  write(repo, '.github/KnowledgeBase/Index_Project.md', '# Project\n\n### Choosing APIs\n\n### Design Explanation\n');
  write(repo, '.github/Learning/Learning_Coding.md', '# !!!LEARNING!!!\n\n# Orders\n- Root cause [4]\n- Small functions [2]\n\n# Refinements\n## Root cause\nDetails\n');
  const d = documents(repo, 'knowledge').find(d => d.path.endsWith('KB_Project_Api.md'));
  assert.equal(d.body, body); assert.equal(d.format, 'native');
  assert.equal(documents(repo, 'learning').find(d => d.path.endsWith('Learning_Coding.md')).learningCount, 2);
  assert.equal(documents(repo, 'knowledge').some(d => d.path.endsWith('/Learning.md')), false);
});

test('custom prompts preserve original style, legacy schema and immutable builtins', t => {
  const { repo } = fixture(t); const p = promptTemplate('errors');
  p.sections[0].body = '- Prefer a clear error over silent fallback.\n  - Unless explicitly instructed, fail immediately.';
  putPrompt(repo, p); enablePrompt(repo, p.id, true);
  assert.ok(renderPrompt(prompts(repo).find(q => q.id === p.id)).includes(p.sections[0].body));
  for (const builtin of builtinPrompts()) assert.throws(() => putPrompt(repo, builtin), /内置规范/);
  const old = { schemaVersion: 1, id: 'old', title: 'Old', scope: 'project', appliesTo: 'project', prefer: ['a'], avoid: ['b'], examples: [{ good: 'a', bad: 'b', why: 'difference' }], exceptions: [], checks: ['check'], sources: [] };
  putPrompt(repo, old); assert.ok(renderPrompt(prompts(repo).find(q => q.id === 'old')).includes('difference'));
  enablePrompt(repo, 'cpp', true); assert.ok(prompts(repo).find(q => q.id === 'cpp').enabled);
  assert.throws(() => putPrompt(repo, { ...p, sections: [{ ...p.sections[0], source: { path: 'fake' } }] }), /冒充/);
  const flat = structuredClone(p); flat.id = 'flat'; delete flat.topics; delete flat.sections[0].topic;
  putPrompt(repo, flat); assert.ok(renderPrompt(prompts(repo).find(q => q.id === 'flat')).includes(flat.sections[0].body));
  assert.throws(() => renderPrompt(p, 'missing'), /主题不存在/);
  assert.throws(() => putPrompt(repo, { ...p, sections: [{ ...p.sections[0], topic: 'missing' }] }), /主题/);
});

test('retired builtin selections are ignored and migrated without deleting user documents', t => {
  const { repo, state } = fixture(t);
  const p = promptTemplate('team'); putPrompt(repo, p);
  const cfg = config(repo); cfg.enabledPrompts = ['general', 'cpp', 'workflow', 'vczh-project', 'team'];
  save(managed(repo, 'project.json'), cfg);
  assert.deepEqual(prompts(repo).filter(p => p.enabled).map(p => p.id), ['general', 'cpp', 'team']);
  assert.deepEqual(panel(state, { view: 'builtin', id: 'workflow', page: 20 }), panel(state));
  for (const id of ['workflow', 'vczh-project']) {
    assert.throws(() => enablePrompt(repo, id, true), /不存在/);
    assert.throws(() => putPrompt(repo, { ...p, id }), /内置规范/);
  }
  init(repo);
  assert.deepEqual(json(managed(repo, 'project.json')).enabledPrompts, ['general', 'cpp', 'team']);
  assert.deepEqual(json(managed(repo, 'prompts/team.json')), p);
});

test('managed and native document paths reject symlink escape', t => {
  const f = fixture(t), outside = join(f.dir, 'outside'); mkdirSync(outside);
  rmSync(join(f.repo, '.github'), { recursive: true }); symlinkSync(outside, join(f.repo, '.github'));
  assert.throws(() => init(f.repo), /符号链接/); assert.equal(existsSync(join(outside, 'vczh')), false);
});

test('dimension, topic, custom prompt, knowledge and archive pages satisfy the panel contract', t => {
  const f = fixture(t);
  for (let i = 0; i < 7; i++) { write(f.repo, `.github/KnowledgeBase/KB_Project_${i}.md`, '# Topic\n' + 'content '.repeat(600)); putPrompt(f.repo, promptTemplate(`custom-${i}`)); }
  write(f.repo, logPath, investigation); remember(f.repo);
  const queue = [{ view: 'overview' }], seen = new Set();
  while (queue.length) {
    const view = queue.shift(), key = JSON.stringify(view); if (seen.has(key)) continue; seen.add(key);
    const output = panel(f.state, view); assert.doesNotThrow(() => panelItems(JSON.stringify(output), { actions: { browse: {} } }), key);
    for (const item of output.items.flatMap(x => x.type === 'card' ? x.items : [x])) if (item.type === 'button') queue.push(item.args);
  }
  for (const p of builtinPrompts()) for (const topic of p.topics) assert.ok(seen.has(JSON.stringify({ view: 'builtin', id: p.id, topic: topic.id })));
  assert.throws(() => panel(f.state, { view: 'builtin', id: 'general', topic: 'missing' }), /主题不存在/);
  assert.throws(() => panel(f.state, { view: 'builtin', id: 'general', topic: '../escape' }), /主题标识/);
});

test('CLI exposes complete protocols, read-only routing, native knowledge and prompt authoring', t => {
  const f = fixture(t);
  for (const mode of ['', 'ask', 'investigate', 'review', 'refine', 'kb', 'kb-refine', 'adapter', 'prompts']) assert.equal(f.run(['protocol', ...(mode ? [mode] : [])]).status, 0);
  const file = join(f.dir, 'request.md'); writeFileSync(file, 'kb draft full text');
  const routed = f.run(['route', '--file', file]); assert.equal(JSON.parse(routed.stdout).request, '# Draft\nfull text');
  const r = f.run(['request', 'start', '--file', file]); assert.equal(r.status, 0, r.stderr);
  assert.equal(f.run(['request', 'show', JSON.parse(r.stdout).id]).status, 0);
  const p = join(f.dir, 'prompt.json'); writeFileSync(p, f.run(['prompt', 'template', 'new-prompt']).stdout);
  assert.equal(f.run(['prompt', 'put', '--file', p]).status, 0);
  assert.equal(f.run(['kb', 'list']).status, 0);
  assert.equal(f.run(['source', '../outside']).status, 1);
  assert.equal(f.run(['source', 'Guidelines/Coding.md']).status, 1);
  const topic = f.run(['prompt', 'show', 'cpp', '--topic', 'raii']);
  assert.equal(topic.status, 0, topic.stderr); assert.match(topic.stdout, /RAII/); assert.doesNotMatch(topic.stdout, /# 原子操作/);
  assert.equal(f.run(['prompt', 'show', 'cpp', '--topic', 'missing']).status, 1);
  assert.equal(f.run(['prompt', 'show', 'workflow']).status, 1);
});

test('workflow scripts resume and finish the same request without changing Markdown or running extra stages', t => {
  const f = fixture(t), r = startRequest(f.repo, 'review existing.md'); write(f.repo, logPath, investigation);
  const env = { ...process.env, VCZH_ROOT: f.repo, VCZH_REQUEST: r.id, VCZH_RUN: 'run', GITHUB_OUTPUT: join(f.dir, 'output'), CODA_PLUGIN_STATE: f.state };
  const run = action => spawnSync(process.execPath, [join(plugin, 'scripts/workflow.mjs'), action], { env, encoding: 'utf8' });
  assert.equal(run('route').status, 0); assert.equal(run('route').status, 0);
  assert.match(readFileSync(env.GITHUB_OUTPUT, 'utf8'), /mode=review/);
  assert.equal(run('finish').status, 0); assert.equal(run('finish').status, 0);
  assert.equal(getRequest(f.repo, r.id).status, 'done'); assert.equal(readFileSync(join(f.repo, logPath), 'utf8'), investigation);
});

test('multiple Git worktrees count as one project with readable fallback', t => {
  const f = fixture(t), other = join(f.dir, 'other');
  execFileSync('git', ['-C', f.repo, 'worktree', 'add', '--detach', '--no-checkout', other, 'HEAD'], { stdio: 'ignore' });
  execFileSync('git', ['-C', other, 'read-tree', '--empty']);
  init(other); assert.equal(config(other).projectId, config(f.repo).projectId);
  assert.equal(panel(f.state).items[1].items[0].value, '1');
  rmSync(other, { recursive: true, force: true }); assert.equal(panel(f.state).items[1].items[1].value, '0');
  rmSync(f.repo, { recursive: true, force: true }); assert.equal(panel(f.state).items[1].items[1].value, '1');
});
