import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { panelItems } from '../../check/panel.mjs';
import { config, hash, init, inside, json, lock, managed, runtime, save } from '../../plugins/vczh/scripts/store.mjs';
import { builtinPrompts, enablePrompt, manifest, prompts, promptTemplate, putPrompt, renderPrompt, sourceText, validatePrompt } from '../../plugins/vczh/scripts/prompts.mjs';
import { backups, documents, legacyDocuments, remember } from '../../plugins/vczh/scripts/knowledge.mjs';
import { abandonRequest, bindRequest, finishRequest, getRequest, requestGroup, route, startRequest } from '../../plugins/vczh/scripts/requests.mjs';
import { protocol } from '../../plugins/vczh/scripts/protocol.mjs';
import { panel, readPanel } from '../../plugins/vczh/scripts/panel.mjs';

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
const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function commit(root, message) {
  // Commit the staged tree without consulting a developer's identity, signing or hooks.
  // Fixture commits retain the identity headers already present in their parent commit.
  const parent = git(root, 'rev-parse', 'HEAD'), tree = git(root, 'write-tree');
  const identity = git(root, 'cat-file', '-p', parent).split('\n\n')[0].split('\n').filter(line => /^(author|committer) /.test(line)).join('\n');
  const input = `tree ${tree}\nparent ${parent}\n${identity}\n\n${message}\n`;
  const sha = execFileSync('git', ['-C', root, 'hash-object', '-t', 'commit', '-w', '--stdin'], { input, encoding: 'utf8' }).trim();
  git(root, 'update-ref', 'HEAD', sha);
}

test('committing all changes while running does not carry request ownership into a new checkout', t => {
  const f = fixture(t), r = startRequest(f.repo, 'investigate continue');
  bindRequest(f.repo, r.id, 'original');
  lock(f.repo, 'prompts', () => { git(f.repo, 'add', '-A'); commit(f.repo, 'investigation checkpoint'); });
  const snapshot = git(f.repo, 'rev-parse', 'HEAD');
  finishRequest(f.repo, r.id, 'original');
  const cloned = join(f.dir, 'cloned'), worktree = join(f.dir, 'worktree');
  git(f.dir, 'clone', '-q', '--shared', f.repo, cloned);
  git(f.repo, 'worktree', 'add', '-q', '--detach', worktree, snapshot);
  git(f.repo, 'restore', '--source', snapshot, '--staged', '--worktree', '.');
  for (const repo of [cloned, worktree, f.repo]) {
    init(repo);
    const next = startRequest(repo, 'ask new checkout');
    assert.equal(bindRequest(repo, next.id, 'next').status, 'running');
    assert.doesNotMatch(git(repo, 'ls-files', '--', '.github/vczh'), /requests\/|active-request\.json|\/\.[^/]+\.lock/);
    assert.equal(git(repo, 'status', '--porcelain'), '', 'runtime changes must not dirty tracked project data');
  }
});

test('legacy tracked runtime is preserved as ignored history and never adopted by a fresh checkout', t => {
  const f = fixture(t), old = startRequest(f.repo, 'investigate continue');
  const binding = bindRequest(f.repo, old.id, 'old-run');
  const paths = [`.github/vczh/requests/${old.id}.json`, '.github/vczh/active-request.json', '.github/vczh/.request.lock/owner'];
  save(join(f.repo, paths[0]), binding); save(join(f.repo, paths[1]), { id: old.id }); write(f.repo, paths[2], 'old lock');
  write(f.repo, '.github/vczh/.gitignore', '# User rules\n/private-notes/\n');
  putPrompt(f.repo, promptTemplate('team'));
  git(f.repo, 'add', '-A'); commit(f.repo, 'legacy runtime snapshot');
  finishRequest(f.repo, old.id, 'old-run');
  const history = paths.map(path => readFileSync(join(f.repo, path), 'utf8'));
  for (const entry of ['init', 'start']) {
    const repo = join(f.dir, entry); git(f.dir, 'clone', '-q', '--shared', f.repo, repo);
    assert.ok(git(repo, 'ls-files', '--', ...paths));
    if (entry === 'init') init(repo);
    const request = startRequest(repo, 'ask new work');
    assert.equal(bindRequest(repo, request.id, entry).status, 'running');
    assert.throws(() => getRequest(repo, old.id), /仅保留为历史/);
    assert.equal(git(repo, 'ls-files', '--', ...paths), '');
    assert.deepEqual(git(repo, 'check-ignore', '--', ...paths).split('\n'), paths);
    assert.deepEqual(paths.map(path => readFileSync(join(repo, path), 'utf8')), history);
    const shared = ['Project.md', '.github/vczh/project.json', '.github/vczh/prompts/team.json'];
    assert.deepEqual(git(repo, 'ls-files', '--', ...shared).split('\n').sort(), shared.sort());
    const ignore = readFileSync(managed(repo, '.gitignore'), 'utf8'); assert.ok(ignore.startsWith('# User rules\n/private-notes/\n'));
    init(repo);
    assert.equal(readFileSync(managed(repo, '.gitignore'), 'utf8'), ignore, 'migration is idempotent');
    assert.equal(getRequest(repo, request.id, entry).status, 'running', 'initialization must not release a current private request');
  }
});

test('runtime migration does not discard an index-only version of a legacy request', t => {
  const f = fixture(t), path = '.github/vczh/requests/old.json';
  write(f.repo, path, 'original'); git(f.repo, 'add', '-f', '--', path); commit(f.repo, 'tracked legacy request');
  write(f.repo, path, 'staged'); git(f.repo, 'add', '-f', '--', path); write(f.repo, path, 'working');
  assert.throws(() => init(f.repo), /git/);
  assert.equal(git(f.repo, 'show', `:${path}`), 'staged');
  assert.equal(readFileSync(join(f.repo, path), 'utf8'), 'working');
});

test('legacy runtime outside a sparse checkout is removed from the index without blocking new requests', t => {
  const f = fixture(t), paths = ['.github/vczh/requests/old.json', '.github/vczh/active-request.json', '.github/vczh/.request.lock/owner'];
  for (const path of paths) write(f.repo, path, 'legacy runtime snapshot');
  git(f.repo, 'add', '-A'); git(f.repo, 'add', '-f', '--', ...paths); commit(f.repo, 'legacy runtime for sparse checkout');
  for (const entry of ['init', 'start']) {
    const repo = join(f.dir, entry); git(f.dir, 'clone', '-q', '--shared', f.repo, repo);
    git(repo, 'sparse-checkout', 'set', '--no-cone', '/.github/vczh/project.json', '/source.js');
    for (const path of paths) {
      assert.equal(git(repo, 'ls-files', '-v', '--', path), `S ${path}`);
      assert.equal(existsSync(join(repo, path)), false);
    }
    if (entry === 'init') init(repo);
    const request = startRequest(repo, 'ask new work');
    assert.equal(bindRequest(repo, request.id, entry).status, 'running');
    assert.equal(git(repo, 'ls-files', '--', ...paths), '');
    for (const path of paths) {
      assert.equal(git(repo, 'show', `HEAD:${path}`), 'legacy runtime snapshot');
      assert.equal(existsSync(join(repo, path)), false, 'migration must not materialize sparse history');
    }
    init(repo);
    assert.equal(getRequest(repo, request.id, entry).status, 'running');
  }
});

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
    assert.match(output, /vczh prompt list/);
    assert.doesNotMatch(output, /vczh prompt (?:show|enable) (?:general|cpp)\b/);
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

test('task-file expansion rejects additional instructions and mismatched tags without losing the request', t => {
  const f = fixture(t), tag = '<tagging REPO-ROOT/task.md>', file = join(f.dir, 'latest.md');
  write(f.repo, 'task.md', 'Original task\n');
  for (const prefix of ['investigate repro', 'review']) {
    assert.ok(route(f.repo, `${prefix} ${tag}`, { taskFile: 'task.md' }).request.includes(prefix === 'review' ? tag : 'Original task'));
    for (const body of [`${tag}\n另需保持现有 API 兼容`, '@task.md\nkeep constraints', '<tagging REPO-ROOT/other.md>', 'extra instructions']) {
      const latest = `${prefix} ${body}`;
      writeFileSync(file, latest);
      for (const command of [['route'], ['request', 'start']]) {
        const result = f.run([...command, '--file', file, '--task-file', 'task.md']);
        assert.equal(result.status, 1, result.stdout); assert.match(result.stderr, /附加说明/);
      }
      const accepted = startRequest(f.repo, latest);
      assert.equal(accepted.latest, latest); assert.ok(getRequest(f.repo, accepted.id).request.endsWith(body));
    }
  }
  assert.equal(readdirSync(runtime(f.repo, 'requests')).length, 8, 'only complete requests are persisted');
  assert.throws(() => route(f.repo, 'ask question', { taskFile: 'task.md' }), /只用于/);
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

test('abandoning a stopped request preserves documents and releases the next request without reviving the old one', t => {
  const f = fixture(t);
  const paths = [logPath, '.github/KnowledgeBase/Index.md', '.github/Learning/Learning_Coding.md'];
  const before = paths.map(path => readFileSync(join(f.repo, path), 'utf8'));
  for (const state of ['failed', 'cancelled', 'succeeded']) {
    const a = startRequest(f.repo, 'investigate continue'), b = startRequest(f.repo, 'kb topic next');
    const runId = `run-${state}`; bindRequest(f.repo, a.id, runId);
    const status = { runId, workflow: 'vczh', inputs: { root: f.repo, request: a.id }, state, finishedAt: Date.now(), jobs: [{ state }] };
    const file = join(f.dir, 'run-status.json'); writeFileSync(file, JSON.stringify(status));
    const result = f.run(['request', 'abandon', a.id, '--run-status', file, '--reason', 'Original run stopped']);
    assert.equal(result.status, 0, result.stderr);
    const abandoned = JSON.parse(result.stdout);
    assert.equal(abandoned.status, 'abandoned'); assert.equal(abandoned.abandonment.runState, state);
    assert.equal(abandoned.abandonment.reason, 'Original run stopped'); assert.ok(abandoned.finishedAt);
    assert.equal(existsSync(runtime(f.repo, 'active-request.json')), false);
    bindRequest(f.repo, b.id, 'next');
    assert.throws(() => bindRequest(f.repo, a.id, runId), /已结束/);
    assert.throws(() => finishRequest(f.repo, a.id, runId), /已结束/);
    assert.equal(f.run(['request', 'show', a.id, '--run-id', runId]).status, 1);
    abandonRequest(f.repo, a.id, { reason: 'Repeat cleanup' });
    assert.equal(getRequest(f.repo, b.id, 'next').status, 'running', 'repeat cleanup does not release another request');
    finishRequest(f.repo, b.id, 'next');
    assert.throws(() => bindRequest(f.repo, b.id, 'next'), /已结束/);
  }
  assert.deepEqual(paths.map(path => readFileSync(join(f.repo, path), 'utf8')), before);
  const pending = startRequest(f.repo, 'ask unused');
  assert.equal(abandonRequest(f.repo, pending.id, { reason: 'Not started' }).status, 'abandoned');
  const counts = panel(f.state).items.flatMap(item => item.items ?? []).find(item => item.label === '进行中 / 已完成 / 已放弃');
  assert.equal(counts.value, '0 / 3 / 4');
});

test('abandon rejects missing, mismatched or still-active run evidence and keeps its lock', t => {
  const f = fixture(t), r = startRequest(f.repo, 'investigate continue');
  bindRequest(f.repo, r.id, 'original');
  const status = { runId: 'original', workflow: 'vczh', inputs: { root: f.repo, request: r.id }, state: 'cancelled', finishedAt: Date.now(), jobs: [{ state: 'cancelled' }] };
  const evidence = [undefined, { ...status, runId: 'other' }, { ...status, inputs: { ...status.inputs, root: '/other' } },
    { ...status, inputs: { ...status.inputs, request: 'other' } }, { ...status, finishedAt: null },
    ...['running', 'waiting', 'cancelling', 'unknown'].map(state => ({ ...status, state })),
    ...['queued', 'running', 'agent', 'user', 'unknown'].map(state => ({ ...status, jobs: [{ state }] })),
    { ...status, tasks: [{ task: 'open' }] }];
  for (const runStatus of evidence) {
    assert.throws(() => abandonRequest(f.repo, r.id, { reason: 'Abandon', runStatus }));
    assert.equal(getRequest(f.repo, r.id, 'original').status, 'running');
  }
  assert.throws(() => getRequest(f.repo, r.id, 'different'), /不属于/);
  assert.equal(f.run(['request', 'abandon', r.id, '--reason', 'No evidence']).status, 1);
  const next = startRequest(f.repo, 'ask next');
  assert.throws(() => bindRequest(f.repo, next.id, 'next'), /固定任务文档/);
});

test('abandon matches the historical binding after a repository rename and keeps the same host group', t => {
  const f = fixture(t), r = startRequest(f.repo, 'investigate continue'), renamed = join(f.dir, 'renamed');
  const binding = bindRequest(f.repo, r.id, 'original'), group = requestGroup(f.repo);
  const status = { runId: 'original', workflow: 'vczh', inputs: { root: f.repo, request: r.id }, state: 'cancelled', finishedAt: Date.now(), jobs: [] };
  renameSync(f.repo, renamed);
  assert.equal(requestGroup(renamed), group);
  assert.equal(binding.boundRoot, f.repo);
  const next = startRequest(renamed, 'ask next');
  assert.throws(() => abandonRequest(renamed, r.id, { reason: 'Moved', runStatus: { ...status, inputs: { ...status.inputs, root: renamed } } }), /绑定工作区/);
  assert.equal(abandonRequest(renamed, r.id, { reason: 'Moved', runStatus: status }).status, 'abandoned');
  assert.equal(bindRequest(renamed, next.id, 'next').status, 'running');
});

test('legacy bindings without host serialization cannot be released using a status snapshot', t => {
  const { repo } = fixture(t), r = startRequest(repo, 'investigate continue');
  const binding = bindRequest(repo, r.id, 'old'); delete binding.boundGroup;
  save(runtime(repo, `requests/${r.id}.json`), binding);
  const runStatus = { runId: 'old', workflow: 'vczh', inputs: { root: repo, request: r.id }, state: 'cancelled', finishedAt: Date.now(), jobs: [] };
  assert.throws(() => abandonRequest(repo, r.id, { reason: 'Stop', runStatus }), /宿主独占组/);
  assert.equal(getRequest(repo, r.id, 'old').status, 'running');
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

test('custom prompt IDs remain unique across filenames for reading, toggling and updates', t => {
  const f = fixture(t), p = promptTemplate('team');
  save(managed(f.repo, 'prompts/a.json'), p);
  putPrompt(f.repo, { ...p, title: 'Updated team' });
  assert.equal(prompts(f.repo).find(p => p.id === 'team').title, 'Updated team');
  assert.equal(existsSync(managed(f.repo, 'prompts/team.json')), false);
  save(managed(f.repo, 'prompts/b.json'), p);
  const before = config(f.repo);
  for (const action of [() => prompts(f.repo), () => enablePrompt(f.repo, 'team', true), () => putPrompt(f.repo, p)])
    assert.throws(action, /team.*a\.json.*b\.json/);
  for (const args of [['prompt', 'list'], ['prompt', 'show', 'team']]) {
    const result = f.run(args); assert.equal(result.status, 1); assert.match(result.stderr, /a\.json.*b\.json/);
  }
  assert.deepEqual(config(f.repo), before);
});

test('disabled builtins stay disabled across every protocol while enabled project prompts remain selectable', t => {
  const f = fixture(t); putPrompt(f.repo, promptTemplate('team')); enablePrompt(f.repo, 'team', true);
  enablePrompt(f.repo, 'cpp', true);
  for (const key of ['general', 'cpp']) assert.equal(f.run(['prompt', 'disable', key]).status, 0);
  const before = config(f.repo);
  for (const mode of ['', 'adapter', 'prompts', 'ask', 'investigate', 'review', 'refine', 'kb', 'kb-refine', 'direct']) {
    const result = f.run(['protocol', ...(mode ? [mode] : [])]); assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /vczh prompt (?:show|enable) (?:general|cpp)\b/);
    assert.match(result.stdout, /enabled.*true/);
  }
  const listed = JSON.parse(f.run(['prompt', 'list']).stdout);
  assert.deepEqual(listed.filter(p => p.enabled).map(p => p.id), ['team']);
  assert.deepEqual(config(f.repo), before);
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
  assert.equal(run('workspace').status, 0);
  assert.equal(readFileSync(env.GITHUB_OUTPUT, 'utf8'), `group=${requestGroup(f.repo)}\n`);
  assert.equal(run('route').status, 1, 'binding requires the host group output');
  assert.equal(getRequest(f.repo, r.id).status, 'pending');
  env.VCZH_GROUP = requestGroup(f.repo);
  assert.equal(run('route').status, 0); assert.equal(run('route').status, 0);
  assert.match(readFileSync(env.GITHUB_OUTPUT, 'utf8'), /mode=review/);
  assert.equal(run('finish').status, 0); assert.equal(run('finish').status, 0);
  assert.equal(getRequest(f.repo, r.id).status, 'done'); assert.equal(readFileSync(join(f.repo, logPath), 'utf8'), investigation);
});

test('persisted archive details return to overview after refine deletes the archive', t => {
  const f = fixture(t), viewFile = join(f.state, 'view.json');
  write(f.repo, logPath, investigation); remember(f.repo);
  const archive = documents(f.repo, 'archives')[0];
  const view = { view: 'detail', key: hash(f.repo), kind: 'archives', id: archive.id };
  const run = args => spawnSync(process.execPath, [join(plugin, 'scripts/panel.mjs'), ...args], { encoding: 'utf8', env: {
    ...process.env, CODA_PLUGIN_STATE: f.state, CODA_PANEL_ARGS: JSON.stringify(view),
  } });
  assert.equal(run(['--browse']).status, 0);
  assert.match(run([]).stdout, /PROBLEM DESCRIPTION/);
  rmSync(join(f.repo, archive.path));
  assert.throws(() => panel(f.state, view), /条目不存在/, 'an explicit stale selection is still an error');
  const refreshed = run([]);
  assert.equal(refreshed.status, 0, refreshed.stderr);
  assert.deepEqual(JSON.parse(refreshed.stdout), panel(f.state));
  assert.equal(existsSync(viewFile), false);
  assert.equal(run([]).status, 0, 'later refreshes no longer reload the deleted entry');
});

test('persisted workspace selections recover from removal or replacement, but data errors stay visible', t => {
  const f = fixture(t), viewFile = join(f.state, 'view.json');
  const view = { view: 'project', key: hash(f.repo), kind: 'prompts' };
  save(viewFile, view);
  write(f.repo, '.github/vczh/prompts/broken.json', '{');
  assert.throws(() => readPanel(f.state), /JSON/);
  assert.deepEqual(json(viewFile), view, 'a corrupt prompt must not be mistaken for a deleted selection');
  rmSync(managed(f.repo, 'prompts/broken.json'));
  const cfg = config(f.repo); save(managed(f.repo, 'project.json'), { ...cfg, projectId: 'replacement' });
  assert.deepEqual(readPanel(f.state), panel(f.state));
  assert.equal(existsSync(viewFile), false);
  save(viewFile, view); rmSync(f.repo, { recursive: true });
  assert.deepEqual(readPanel(f.state), panel(f.state));
  assert.equal(existsSync(viewFile), false);
  writeFileSync(viewFile, '{');
  assert.throws(() => readPanel(f.state), /JSON/);
});

test('multiple Git worktrees count as one project with readable fallback', t => {
  const f = fixture(t), other = join(f.dir, 'other');
  execFileSync('git', ['-C', f.repo, 'worktree', 'add', '--detach', '--no-checkout', other, 'HEAD'], { stdio: 'ignore' });
  execFileSync('git', ['-C', other, 'read-tree', '--empty']);
  init(other); assert.equal(config(other).projectId, config(f.repo).projectId);
  assert.equal(panel(f.state).items[1].items[0].value, '1');
  for (const [repo, registeredAt] of [[f.repo, '2020-01-01'], [other, '2021-01-01']]) {
    const file = join(f.state, 'projects', `${hash(repo)}.json`); save(file, { ...json(file), registeredAt });
  }
  const view = join(f.state, 'view.json'); save(view, { view: 'project', key: hash(f.repo), kind: 'knowledge' });
  assert.deepEqual(readPanel(f.state), panel(f.state), 'switching the selected worktree clears the saved selection');
  assert.equal(existsSync(view), false);
  rmSync(other, { recursive: true, force: true }); assert.equal(panel(f.state).items[1].items[1].value, '0');
  rmSync(f.repo, { recursive: true, force: true }); assert.equal(panel(f.state).items[1].items[1].value, '1');
});

test('a corrupt project name is isolated from healthy projects in the persisted overview', t => {
  const f = fixture(t), other = join(f.dir, 'other');
  git(f.dir, 'clone', '-q', '--shared', '--no-checkout', root, other);
  const cfg = { ...config(f.repo), projectId: hash(other), name: 'Healthy project' };
  save(join(other, '.github/vczh/project.json'), cfg);
  save(join(f.state, 'projects', `${hash(other)}.json`), { root: other, projectId: cfg.projectId, name: cfg.name });
  const recordFile = join(f.state, 'projects', `${hash(f.repo)}.json`), record = json(recordFile), original = config(f.repo);
  save(join(f.state, 'view.json'), { view: 'overview' });
  for (const name of [null, 42, '', '   ']) {
    save(managed(f.repo, 'project.json'), { ...original, name });
    for (const cachedName of [record.name, name]) {
      save(recordFile, { ...record, name: cachedName });
      const output = readPanel(f.state);
      assert.doesNotThrow(() => panelItems(JSON.stringify(output), { actions: { browse: {} } }));
      assert.ok(output.items.some(item => item.title === 'Healthy project'));
      const stats = output.items.find(item => item.title === '项目知识总览').items;
      assert.equal(stats.find(item => item.label === '已登记项目').value, '2');
      assert.equal(stats.find(item => item.label === '暂不可读取').value, '1');
      assert.match(JSON.stringify(output), /项目名称/);
      assert.throws(() => config(f.repo), /项目名称/);
    }
  }
});
