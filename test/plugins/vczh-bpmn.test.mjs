// Optional integration with an installed Coda host. The test acts as the user-task agent;
// the real workflow engine, scheduler, cancellation, resumption and script runner do the rest.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { init } from '../../plugins/vczh/scripts/store.mjs';
import { abandonRequest, getRequest, requestGroup, startRequest } from '../../plugins/vczh/scripts/requests.mjs';

const runtime = process.env.VCZH_CODA_RUNTIME;
const root = fileURLToPath(new URL('../..', import.meta.url)), plugin = join(root, 'plugins/vczh');
async function fixture(t) {
  const load = name => import(pathToFileURL(join(runtime, 'src', name)));
  const { ProductStore } = await load('storage/product-store.mjs');
  const { ProductService } = await load('application/service.mjs');
  const { readPlugin, builtinPlugins } = await load('components/plugins/plugin-rules.mjs');
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'vczh-host-'))), repo = join(dir, 'repo'), state = join(dir, 'state');
  mkdirSync(state); mkdirSync(join(state, 'hosts'));
  execFileSync('git', ['clone', '-q', '--shared', '--no-checkout', root, repo]);
  execFileSync('git', ['-C', repo, 'read-tree', '--empty']); init(repo);
  const store = new ProductStore(':memory:');
  const service = new ProductService(store, { root: state, hostsDir: join(state, 'hosts'), workflows: { systemTempRoot: join(dir, 'work') },
    plugins: { catalog: new Map([...builtinPlugins(), ['vczh', readPlugin(plugin, { kind: 'builtin' })]]) } });
  service.deliver = () => {}; // Tasks are answered below; never launch a language model.
  function wait(read) {
    return new Promise((resolve, reject) => {
      const finish = (error, value) => { off(); clearTimeout(timer); if (error) reject(error); else resolve(value); };
      const check = () => { try { const value = read(); if (value) finish(null, value); } catch (error) { finish(error); } };
      const off = service.kernel.watch('runRecords', check);
      const timer = setTimeout(() => finish(new Error('Coda did not reach the expected state')), 15000);
      check();
    });
  }
  const live = () => store.all("SELECT id FROM workflow_runs WHERE state IN ('waiting', 'running', 'cancelling')");
  t.after(async () => {
    try {
      for (const row of live()) await service.workflows.calls.stop(service.workflows.get(row.id));
      await wait(() => !live().length);
    } finally {
      await service.close({ stopSessions: true }); await store.close(); rmSync(dir, { recursive: true, force: true });
    }
  });
  service.plugins.install('vczh');
  const project = store.createProject({ name: 'Test', rootPath: repo }), thread = randomUUID(), checkout = randomUUID(), now = Date.now();
  store.run("INSERT INTO checkouts(id, project_id, kind, path, state, created_at) VALUES (?, ?, 'original', ?, 'ready', ?)", checkout, project.id, repo, now);
  store.run("INSERT INTO threads(id, project_id, checkout_id, agent, title, settings_json, created_at, updated_at) VALUES (?, ?, ?, 'codex', 'Test', '{}', ?, ?)", thread, project.id, checkout, now, now);
  const call = async (name, args) => JSON.parse(await service.workflows.tool(thread, name, args, { cause: () => null }));
  const tasks = id => service.workflowTasks.pending(id), run = id => service.workflows.get(id);
  return { repo, store, wait, call, tasks, run,
    start: async request => (await call('workflow_run', { workflow: 'vczh', requestId: request.id, inputs: { root: repo, request: request.id } })).runId,
    task: id => wait(() => {
      assert.ok(!['succeeded', 'failed', 'cancelled'].includes(run(id).state), JSON.stringify(run(id).error));
      return tasks(id)[0];
    }),
    stop: async id => { await call('workflow_cancel', { runId: id }); await wait(() => run(id).state === 'cancelled'); },
  };
}

test('actual Coda host runs all original command branches and resumes a cancelled investigation', { skip: !runtime }, async t => {
  const f = await fixture(t);
  const samples = { ask: 'ask why?', investigate: 'investigate continue', review: 'review task.md', refine: 'refine', kb: 'kb draft details', 'kb-refine': 'kb refine', direct: 'fix CI script' };
  for (const [mode, latest] of Object.entries(samples)) {
    const request = startRequest(f.repo, latest, { intent: 'maintenance' }), id = await f.start(request);
    let task = await f.task(id); assert.equal(task.step, mode);
    if (mode === 'investigate') {
      await f.stop(id); await f.call('workflow_resume', { runId: id });
      task = await f.task(id); assert.equal(task.step, mode);
    }
    assert.equal(getRequest(f.repo, request.id, id).boundGroup, requestGroup(f.repo));
    await f.call('workflow_task', { runId: id, task: task.task, result: 'completed' });
    await f.wait(() => f.run(id).state === 'succeeded');
    assert.equal(getRequest(f.repo, request.id).status, 'done');
  }
});

test('resuming after terminal evidence cannot overlap an abandoned request with its successor', { skip: !runtime }, async t => {
  const f = await fixture(t), request = startRequest(f.repo, 'investigate continue'), old = await f.start(request);
  await f.task(old); await f.stop(old);
  const evidence = await f.call('workflow_status', { runId: old });
  await f.call('workflow_resume', { runId: old });
  const oldTask = await f.task(old);
  // The resumed agent has already passed its read guard before the saved terminal proof is used.
  getRequest(f.repo, request.id, old);
  abandonRequest(f.repo, request.id, { reason: 'Terminal evidence was superseded by a resume', runStatus: evidence });
  const next = startRequest(f.repo, 'ask successor'), successor = await f.start(next);
  await f.wait(() => f.store.one("SELECT 1 FROM group_holds WHERE run_id = ? AND state = 'waiting'", successor));
  assert.equal(getRequest(f.repo, next.id).status, 'pending'); assert.deepEqual(f.tasks(successor), []);
  // Finish refuses the abandoned request. The resulting failed run resumes in-place at finish,
  // without rerunning route; its old scope must still reacquire the group before it can execute.
  await f.call('workflow_task', { runId: old, task: oldTask.task, result: 'completed' });
  await f.wait(() => f.run(old).state === 'failed');
  const nextTask = await f.task(successor);
  await f.call('workflow_resume', { runId: old });
  await f.wait(() => f.store.one("SELECT 1 FROM group_holds WHERE run_id = ? AND state = 'waiting'", old));
  assert.equal(f.run(old).rounds.at(-1).resumed, true);
  assert.deepEqual(f.tasks(old), []);
  assert.equal(getRequest(f.repo, next.id, successor).status, 'running');
  await f.call('workflow_task', { runId: successor, task: nextTask.task, result: 'completed' });
  await f.wait(() => f.run(successor).state === 'succeeded' && f.run(old).state === 'failed');
  assert.equal(getRequest(f.repo, request.id).status, 'abandoned');
  assert.equal(getRequest(f.repo, next.id).status, 'done');
});
