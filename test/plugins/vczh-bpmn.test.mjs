// Optional integration against a locally installed Coda runtime, without vendoring its dependencies.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { init } from '../../plugins/vczh/scripts/store.mjs';
import { getRequest, startRequest } from '../../plugins/vczh/scripts/requests.mjs';

const runtime = process.env.VCZH_CODA_RUNTIME;
test('actual Coda BPMN engine runs all original command branches and resumes a waiting investigation', { skip: !runtime }, async t => {
  const require = createRequire(join(runtime, 'package.json'));
  const { Engine } = require('bpmn-engine');
  const workflowSource = existsSync(join(runtime, 'src/components/workflows/bpmn.mjs')) ? 'src/components/workflows' : 'src/domain';
  const { CODA_MODDLE, parseBpmn } = await import(pathToFileURL(join(runtime, workflowSource, 'bpmn.mjs')));
  const { read, isExpression, isTemplate } = await import(pathToFileURL(join(runtime, workflowSource, 'expressions.mjs')));
  const root = fileURLToPath(new URL('../..', import.meta.url)), plugin = join(root, 'plugins/vczh');
  const path = join(plugin, '.coda/workflows/vczh.bpmn'), source = readFileSync(path, 'utf8');
  await parseBpmn(path, source);
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'vczh-bpmn-')));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const repo = join(folder, 'repo');
  execFileSync('git', ['clone', '-q', '--shared', '--no-checkout', root, repo]);
  execFileSync('git', ['-C', repo, 'read-tree', '--empty']); init(repo);
  const samples = { ask: 'ask why?', investigate: 'investigate continue', review: 'review task.md', refine: 'refine', kb: 'kb draft details', 'kb-refine': 'kb refine', direct: 'fix CI script' };
  for (const [mode, latest] of Object.entries(samples)) {
    const request = startRequest(repo, latest, { intent: 'maintenance' }), runId = `run-${mode}`;
    const results = {}, scriptIds = [], waits = [];
    const listener = new EventEmitter();
    listener.on('activity.wait', api => waits.push(api.id));
    listener.on('activity.end', api => { if (api.content.output) results[api.id] = api.content.output; });
    const scripts = { register() {}, getScript(format, activity) {
      if (activity.type !== 'bpmn:ScriptTask') return;
      return { execute(scope, callback) {
        try {
          scriptIds.push(activity.id);
          const output = join(folder, `${mode}-${activity.id}.out`);
          const result = spawnSync(process.execPath, [join(plugin, 'scripts/workflow.mjs'), activity.id], { encoding: 'utf8', env: {
            ...process.env, VCZH_ROOT: repo, VCZH_REQUEST: request.id, VCZH_RUN: runId, GITHUB_OUTPUT: output
          } });
          assert.equal(result.status, 0, result.stderr);
          callback(null, Object.fromEntries(readFileSync(output, 'utf8').trim().split('\n').map(line => line.split('='))));
        } catch (error) { callback(error); }
      } };
    } };
    const expressions = { resolveExpression: (value, context) => read(value, { ...context?.environment?.variables, ...results }), isExpression, hasExpression: value => isExpression(value) || isTemplate(value) };
    const options = { source, moddleOptions: { coda: CODA_MODDLE }, variables: { inputs: { root: repo, request: request.id }, run: { id: runId } }, scripts, expressions };
    let failure, ended = false;
    let engine = new Engine(options);
    engine.on('error', e => { failure = e; });
    let execution = await engine.execute({ listener });
    assert.equal(failure, undefined); assert.deepEqual(waits, [mode]);
    if (mode === 'investigate') {
      const snapshot = await engine.getState(); await engine.stop();
      engine = new Engine(options).recover(snapshot);
      engine.on('error', e => { failure = e; });
      execution = await engine.resume({ listener });
    }
    engine.on('end', () => { ended = true; });
    execution.signal({ id: mode });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(failure, undefined); assert.equal(ended, true, mode);
    assert.deepEqual(scriptIds, ['route', 'finish']);
    assert.equal(getRequest(repo, request.id).status, 'done');
  }
});
