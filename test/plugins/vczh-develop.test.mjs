import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';

const repository = fileURLToPath(new URL('../..', import.meta.url));
const script = join(repository, 'plugins/vczh/scripts/develop.mjs');
const runtime = process.env.VCZH_CODA_RUNTIME;

export function fixture(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'vczh-delivery-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const work = join(dir, 'repo'), origin = join(dir, 'origin.git'), artifacts = join(dir, 'artifacts');
  for (const path of [work, artifacts, join(dir, 'bin'), join(dir, 'state')]) mkdirSync(path);
  const env = { ...process.env, CODA_ARTIFACTS: artifacts, CODA_PLUGIN_STATE: join(dir, 'state'),
    GITHUB_OUTPUT: join(dir, 'output'), GITHUB_RUN_ID: 'fixture-run', CODA_THREAD_ID: 'author-session', FIXTURE: dir,
    PATH: `${join(dir, 'bin')}:${process.env.PATH}`, GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: `url.${origin}.insteadOf`, GIT_CONFIG_VALUE_0: 'https://github.com/fixture/vczh-demo.git' };
  const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const identity = execFileSync('git', ['-C', repository, 'cat-file', '-p', 'HEAD'], { encoding: 'utf8' })
    .split('\n\n')[0].split('\n').filter(line => /^(author|committer) /.test(line)).join('\n');
  const commit = (root, message) => {
    git(root, 'add', '-A');
    const parent = spawnSync('git', ['-C', root, 'rev-parse', '--verify', 'HEAD'], { encoding: 'utf8', env });
    const input = `tree ${git(root, 'write-tree')}\n${parent.status === 0 ? `parent ${parent.stdout.trim()}\n` : ''}${identity}\n\n${message}\n`;
    const head = execFileSync('git', ['-C', root, 'hash-object', '-t', 'commit', '-w', '--stdin'], { input, encoding: 'utf8', env }).trim();
    git(root, 'update-ref', 'HEAD', head); return head;
  };
  git(work, 'init', '-q', '-b', 'main'); writeFileSync(join(work, 'source.txt'), 'base\n'); commit(work, 'baseline');
  git(work, 'clone', '--bare', '-q', work, origin); git(work, 'remote', 'add', 'origin', origin);
  const fake = join(dir, 'bin/gh');
  writeFileSync(fake, `#!${process.execPath}\n${String.raw`
const fs = require('node:fs');
const dir = process.env.FIXTURE, args = process.argv.slice(2);
const file = dir + '/github.json', gh = JSON.parse(fs.readFileSync(file, 'utf8'));
const statePath = process.env.CODA_ARTIFACTS + '/vczh-develop.json';
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : {};
fs.appendFileSync(dir + '/calls', JSON.stringify({ args, thread: process.env.CODA_THREAD_ID ?? null,
  body: args.includes('--body-file') ? fs.readFileSync(args[args.indexOf('--body-file') + 1], 'utf8') : null }) + '\n');
if (args[0] === 'repo') console.log(args.includes('--jq') ? gh.base : JSON.stringify({nameWithOwner:'fixture/vczh-demo',defaultBranchRef:{name:gh.base}}));
else if (args[1] === 'list') console.log(JSON.stringify(gh.pr ? [{url:gh.pr}] : []));
else if (args[1] === 'create') { gh.pr='https://github.com/fixture/vczh-demo/pull/1';console.log(gh.pr); }
else if (args[1] === 'view') console.log(JSON.stringify({state:gh.state,headRefOid:gh.head || state.head,baseRefName:gh.base,mergeable:gh.conflict?'CONFLICTING':'MERGEABLE',mergeCommit:{oid:'f'.repeat(40)}}));
else if (args[1] === 'merge') { if (gh.conflict) process.exitCode=1; else gh.state='MERGED'; }
else if (args[1] === 'checks') console.log('[]');
fs.writeFileSync(file,JSON.stringify(gh));
`}`);
  chmodSync(fake, 0o755); writeFileSync(join(dir, 'calls'), '');
  writeFileSync(join(dir, 'github.json'), JSON.stringify({ base: 'main', state: 'OPEN' }));
  const run = (action, extra = {}, expected = 0) => {
    writeFileSync(env.GITHUB_OUTPUT, '');
    const done = spawnSync(process.execPath, [script, action], { cwd: work, env: { ...env, ...extra }, encoding: 'utf8' });
    assert.equal(done.status, expected, done.stderr);
    return Object.fromEntries([...readFileSync(env.GITHUB_OUTPUT, 'utf8').matchAll(/(\w+)<<([^\n]+)\n([\s\S]*?)\n\2\n/g)]
      .map(([, name, , value]) => [name, value]));
  };
  const state = () => JSON.parse(readFileSync(join(artifacts, 'vczh-develop.json'), 'utf8'));
  const calls = () => readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const github = patch => {
    const file = join(dir, 'github.json'); writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), ...patch }));
  };
  const change = text => { writeFileSync(join(state().root, 'source.txt'), text); return commit(state().root, text); };
  return { dir, env, work, origin, artifacts, run, state, git, commit, calls, github, change };
}

function develop(t) {
  const f = fixture(t);
  f.run('lane'); f.run('initialize', { GROUP: f.state().group });
  writeFileSync(join(f.state().root, 'TODO_TASK.md'), '用户需求原文\n\n## VERIFICATION\n验证边界\n');
  return f;
}

test('isolated investigation preserves uncommitted work and resumes without resetting Markdown', t => {
  const f = fixture(t); writeFileSync(join(f.work, 'source.txt'), 'user draft');
  const lane = f.run('lane'); f.run('initialize', { GROUP: lane.group });
  assert.equal(readFileSync(join(f.work, 'source.txt'), 'utf8'), 'user draft');
  assert.equal(readFileSync(join(lane.root, 'source.txt'), 'utf8'), 'base\n');
  assert.equal(f.git(lane.root, 'branch', '--show-current'), 'agent/vczh-fixture-run');
  const log = join(lane.root, '.github/TaskLogs/Copilot_Investigate.md');
  writeFileSync(log, 'recorded experiment');
  assert.equal(f.run('lane').root, lane.root); f.run('initialize', { GROUP: lane.group });
  assert.equal(readFileSync(log, 'utf8'), 'recorded experiment');
});

test('one privately owned PR carries exact task and check evidence; new heads invalidate review and acceptance', t => {
  const f = develop(t), first = f.change('first implementation');
  assert.equal(f.run('push', { REPORT: JSON.stringify({ note: '用户汇报' }) }).head, first);
  f.run('checks', { RESULT: JSON.stringify({ runs: JSON.stringify([{ workflow: 'check', state: 'succeeded', runId: 'check-1' }]) }) });
  let pr = f.run('pr', { DEVICES: 'true' });
  assert.equal(pr.task, readFileSync(join(f.state().root, 'TODO_TASK.md'), 'utf8'));
  assert.match(pr.evidence, /check: succeeded coda:\/\/workflow-runs\/check-1/);
  assert.equal(pr.review, 'true'); assert.equal(pr.device, 'true');
  f.run('reviewed', { REVIEW: JSON.stringify({ head: first, decision: 'REQUEST_CHANGES', line: '需要修改', report: '检查边界' }) });
  assert.equal(f.run('pr').review, 'true', 'unhandled requests for changes must survive a restart');
  f.run('kept', { ANSWER: JSON.stringify({ note: '已有调用前置条件' }) });
  f.run('accepted', { ROUTE: 'passed', DEVICE: JSON.stringify({ note: '已按命令确认' }) });
  pr = f.run('pr', { DEVICES: 'true' });
  assert.equal(pr.review, 'false'); assert.equal(pr.device, 'false'); assert.match(pr.summary, /已有调用前置条件/);
  const second = f.change('corrected implementation');
  f.run('push'); pr = f.run('pr', { DEVICES: 'true' });
  assert.equal(pr.head, second); assert.equal(pr.review, 'true'); assert.equal(pr.device, 'true');
  assert.doesNotMatch(pr.summary, /已有调用前置条件/);
  assert.equal(f.calls().filter(c => c.args[1] === 'create').length, 1);
  assert.ok(f.calls().filter(c => c.args[0] === 'pr').every(c => c.thread === null), 'must never report the PR to the independent lifecycle');
  assert.equal(f.git(f.work, 'ls-remote', f.origin, 'refs/heads/vczh/fixture-run').split('\t')[0], second);
});

test('approval and merge reject a changed head or non-default target, and retry recognizes an already merged PR', t => {
  const f = develop(t), head = f.change('implemented');
  f.run('push', { REPORT: JSON.stringify({ note: '实现' }) }); f.run('pr');
  f.github({ head: 'e'.repeat(40) }); f.run('approval', {}, 1); f.run('merge', { METHOD: 'merge' }, 1);
  assert.equal(f.calls().filter(c => c.args[1] === 'merge').length, 0);
  f.github({ head, base: 'another' }); f.run('approval', {}, 1); f.run('merge', { METHOD: 'merge' }, 1);
  f.github({ base: 'main', conflict: true }); assert.equal(f.run('merge', { METHOD: 'merge' }).route, 'conflict');
  assert.match(f.run('problem').text, /rebase/);
  f.github({ conflict: false }); assert.equal(f.run('merge', { METHOD: 'merge' }).commit, 'f'.repeat(40));
  const count = f.calls().filter(c => c.args[1] === 'merge').length;
  assert.equal(f.run('merge', { METHOD: 'merge' }).commit, 'f'.repeat(40));
  assert.equal(f.calls().filter(c => c.args[1] === 'merge').length, count);
  const merge = f.calls().filter(c => c.args[1] === 'merge').at(-1);
  assert.equal(merge.args[merge.args.indexOf('--match-head-commit') + 1], head);
});

test('failed acceptance preserves attachments, incomplete reviews remain distinct, publication uses only chosen options', t => {
  const f = develop(t), head = f.change('implemented');
  f.run('push', { REPORT: JSON.stringify({ note: '实现' }) }); f.run('pr');
  assert.equal(f.run('reviewed', { REVIEW: JSON.stringify({ head, decision: 'INCOMPLETE', line: '服务中断' }) }).incomplete, 'true');
  assert.equal(f.run('pr').review, 'true', 'an incomplete review cannot become a cached pass');
  assert.equal(f.run('accepted', { ROUTE: 'failed', DEVICE: JSON.stringify({ note: '边界仍错', attachments: ['/uploads/evidence.png'] }) }).route, 'fix');
  assert.match(f.run('problem').text, /边界仍错[\s\S]*\/uploads\/evidence.png/);
  assert.deepEqual(f.run('options', { APPROVED: JSON.stringify({ options: { deploy: true, preview: true, release: false, notify: true } }) }),
    { deploy: 'true', release: 'true', releaseKinds: 'preview', notify: 'true' });
  assert.deepEqual(JSON.parse(f.run('notes', { AGENT: JSON.stringify({ note: '修复边界' }) }).inputs), { notes: '修复边界', publish: 'true' });
});

test('a resumed run can revalidate its existing commit without inventing a new code change', t => {
  const f = develop(t), head = f.change('implemented');
  f.run('push', { REPORT: JSON.stringify({ note: '实现' }) });
  assert.equal(f.run('push').route, 'fix');
  assert.equal(f.run('push', { ATTEMPT: '2' }).head, head);
});

test('a transient failure can retry the same head but changed code must be pushed and checked', t => {
  const f = develop(t);
  assert.equal(f.run('retry').route, 'push');
  f.change('implemented');
  f.run('push', { REPORT: JSON.stringify({ note: '实现' }) });
  assert.equal(f.run('retry').route, 'checks');
  f.change('actual correction');
  assert.equal(f.run('retry').route, 'push');
});

test('saved host JSON check results remain readable when resuming at PR and approval', t => {
  const f = develop(t), head = f.change('implemented');
  f.run('push', { REPORT: JSON.stringify({ note: '实现' }) });
  const runs = JSON.stringify([{ workflow: 'check', state: 'succeeded', runId: 'actual-check' }]);
  writeFileSync(join(f.artifacts, 'vczh-develop.json'), JSON.stringify({ ...f.state(), checks: { head, runs } }));
  assert.match(f.run('pr').evidence, /coda:\/\/workflow-runs\/actual-check/);
  assert.match(f.run('approval', { PREMERGE: JSON.stringify({ runs }) }).premerge, /check: succeeded/);
  f.run('checks', { RESULT: JSON.stringify({ runs: '{}' }) }, 1);
});

test('current host reads the develop menu contract and routes without a second PR lifecycle', { skip: !runtime }, async () => {
  const path = join(repository, 'plugins/vczh/.coda/workflows/vczh-develop.bpmn');
  const { readWorkflow } = await import(pathToFileURL(join(runtime, 'node_modules/@coda-console/protocol/workflow.mjs')));
  const result = await readWorkflow(readFileSync(path, 'utf8'), 'vczh-develop');
  assert.ok(!result.problem, result.problem);
  const process = result.root.rootElements.find(e => e.$type === 'bpmn:Process');
  assert.equal(process.kind, 'develop');
  const nodes = Object.fromEntries(process.flowElements.map(e => [e.id, e]));
  assert.equal(nodes.prepare.wake, 'false');
  assert.equal(nodes.review.calledElement, 'review-commit');
  assert.equal(nodes.approve.assignee, 'user');
  assert.equal(nodes['direct-to-push'].targetRef.id, 'push');
  assert.equal(nodes['retry-route-to-checks'].targetRef.id, 'checks');
  assert.ok(!process.flowElements.some(e => e.calledElement === 'pull-request'));
});
