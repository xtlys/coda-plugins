import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { assetsByKind, backups, checkSpecLock, consumeBackup, hasAgentVerifiers, remember, runLints } from '../../plugins/dickda/scripts/assets.mjs';
import { enrichDispatchBatch, evaluateVerificationGate, evaluateVerifierAnswer, integrateWorkerResults } from '../../plugins/dickda/scripts/develop.mjs';
import { builtinPrompts, enablePrompt, promptTemplate, prompts, putPrompt, renderPrompt } from '../../plugins/dickda/scripts/prompts.mjs';
import { applyProseRefinements, buildRefineContext, executeRefinePlan, normalizeDiagnosis } from '../../plugins/dickda/scripts/refine.mjs';
import { ROLES, loadSettings, resolveEngineer, rolePrompt } from '../../plugins/dickda/scripts/roles.mjs';
import { INVESTIGATE_MARKER, init, inside, runtime } from '../../plugins/dickda/scripts/store.mjs';
import { checkoutTargetCommit, runAgentVerifiers, runCodeVerifiers } from '../../plugins/dickda/scripts/verify.mjs';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const pluginDir = join(repoRoot, 'plugins/dickda');
const cliScript = join(pluginDir, 'scripts/cli.mjs');
const developScript = join(pluginDir, 'scripts/develop.mjs');
const verifyScript = join(pluginDir, 'scripts/verify.mjs');
const refineScript = join(pluginDir, 'scripts/refine.mjs');

const identity = execFileSync('git', ['-C', repoRoot, 'cat-file', '-p', 'HEAD'], { encoding: 'utf8' })
  .split('\n\n')[0]
  .split('\n')
  .filter(line => /^(author|committer) /.test(line))
  .join('\n');

function createGitRepo(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'dickda-test-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const work = join(dir, 'work');
  const origin = join(dir, 'origin.git');
  const artifacts = join(dir, 'artifacts');
  for (const p of [work, artifacts, join(dir, 'bin'), join(dir, 'tmp')]) mkdirSync(p, { recursive: true });

  const env = {
    ...process.env,
    CODA_PLUGIN_PATH: pluginDir,
    CODA_ARTIFACTS: artifacts,
    RUNNER_TEMP: join(dir, 'tmp'),
    GITHUB_OUTPUT: join(dir, 'github-output'),
    GITHUB_STEP_SUMMARY: join(dir, 'github-step-summary'),
    GITHUB_RUN_ID: 'run-101',
    CODA_THREAD_ID: 'interactor-session',
    FIXTURE_DIR: dir,
    PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: `url.${origin}.insteadOf`,
    GIT_CONFIG_VALUE_0: 'https://github.com/fixture/dickda-demo.git',
  };

  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

  const commit = (cwd, message) => {
    git(cwd, 'add', '-A');
    const parent = spawnSync('git', ['-C', cwd, 'rev-parse', '--verify', 'HEAD'], { encoding: 'utf8', env });
    const raw = `tree ${git(cwd, 'write-tree')}\n${parent.status === 0 ? `parent ${parent.stdout.trim()}\n` : ''}${identity}\n\n${message}\n`;
    const oid = execFileSync('git', ['-C', cwd, 'hash-object', '-t', 'commit', '-w', '--stdin'], { input: raw, encoding: 'utf8', env }).trim();
    git(cwd, 'update-ref', 'HEAD', oid);
    return oid;
  };

  git(work, 'init', '-q', '-b', 'main');
  git(work, 'config', 'user.name', 'Dickda Test');
  git(work, 'config', 'user.email', 'dickda@example.com');
  writeFileSync(join(work, 'app.mjs'), 'export const answer = () => 42;\n');
  commit(work, 'initial commit');
  git(work, 'clone', '--bare', '-q', work, origin);
  git(work, 'remote', 'add', 'origin', origin);

  return { dir, work, origin, artifacts, env, git, commit };
}

function parseOutputs(file) {
  return Object.fromEntries(
    [...readFileSync(file, 'utf8').matchAll(/(\w+)<<([^\n]+)\n([\s\S]*?)\n\2\n/g)]
      .map(([, k, , v]) => [k, v])
  );
}

function workflowGraph(name) {
  const xml = readFileSync(join(pluginDir, `.coda/workflows/${name}.bpmn`), 'utf8');
  const flows = [...xml.matchAll(/<sequenceFlow id="[^"]+" sourceRef="([^"]+)" targetRef="([^"]+)"(?:\s*\/>|>\s*<conditionExpression[^>]*>([^<]+)<\/conditionExpression>\s*<\/sequenceFlow>)/g)];
  const routes = source => Object.fromEntries(flows.filter(([, from]) => from === source).map(([, , to, when]) => [to, when || 'always']));
  const card = id => xml.match(new RegExp(`<userTask id="${id}"[\\s\\S]*?</userTask>`))[0];
  return { xml, routes, card };
}

const blueprint = ['架构边界', 'Lint 规则', '验证用例', '并发工单', '人工锚点']
  .map((label, index) => `## L${index + 1}\n${label}`).join('\n\n');

function stepRunner({ dir, origin, env, git }, script) {
  // Each step has its own checkout; only artifacts and published refs survive between steps.
  let stepCounter = 0;
  return (step, extra = {}, expectedError) => {
    const stepDir = join(dir, `ephemeral-step-${++stepCounter}`);
    git(dir, 'clone', '-q', origin, stepDir);
    git(stepDir, 'config', 'user.name', 'Dickda Runner');
    git(stepDir, 'config', 'user.email', 'runner@example.com');
    writeFileSync(env.GITHUB_OUTPUT, '');
    const res = spawnSync(process.execPath, [script, step], { cwd: stepDir, env: { ...env, ...extra }, encoding: 'utf8' });
    rmSync(stepDir, { recursive: true, force: true });
    if (expectedError) {
      assert.equal(res.status, 1, res.stderr);
      assert.match(res.stderr, expectedError);
    } else {
      assert.equal(res.status, 0, res.stderr || res.stdout);
    }
    return parseOutputs(env.GITHUB_OUTPUT);
  };
}

function workflowFixture(t, script = developScript) {
  const fixture = createGitRepo(t);
  const { dir } = fixture;
  const ghCallsFile = join(dir, 'gh-calls.jsonl');
  writeFileSync(ghCallsFile, '');
  const fakeGh = join(dir, 'bin/gh');
  writeFileSync(fakeGh, `#!${process.execPath}
const fs = require('node:fs');
const dir = process.env.FIXTURE_DIR;
const args = process.argv.slice(2);
fs.appendFileSync(dir + '/gh-calls.jsonl', JSON.stringify({ args, thread: process.env.CODA_THREAD_ID ?? null }) + '\\n');
const stateFile = process.env.CODA_ARTIFACTS + '/${script === refineScript ? 'refine' : 'develop'}.json';
const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {};
if (args[0] === 'repo') {
  console.log(args.includes('--jq') ? (process.env.DEFAULT_BRANCH || 'main') : JSON.stringify({ nameWithOwner: 'fixture/dickda-demo', defaultBranchRef: { name: 'main' } }));
} else if (args[0] === 'pr' && args[1] === 'list') {
  console.log('[]');
} else if (args[0] === 'pr' && args[1] === 'create') {
  console.log('https://github.com/fixture/dickda-demo/pull/7');
} else if (args[0] === 'pr' && args[1] === 'view') {
  const merged = fs.existsSync(dir + '/merged') && fs.readFileSync(dir + '/merged', 'utf8');
  const conflict = !merged && state.refineBranch && require('node:child_process').spawnSync('git', ['merge-tree', '--write-tree', 'origin/main', state.head]).status === 1;
  console.log(JSON.stringify({ state: merged ? 'MERGED' : 'OPEN', headRefOid: state.head, baseRefName: 'main', mergeable: conflict ? 'CONFLICTING' : 'MERGEABLE', mergeCommit: { oid: merged }, ...JSON.parse(process.env.PR_VIEW || '{}') }));
} else if (args[0] === 'pr' && args[1] === 'merge') {
  let merged = state.head;
  if (state.refineBranch) {
    const git = (...a) => require('node:child_process').execFileSync('git', a, { encoding: 'utf8' }).trim();
    git('merge', '--squash', state.head);
    git('commit', '-m', 'Merge approved refinement');
    merged = git('rev-parse', 'HEAD');
    git('push', 'origin', 'HEAD:main', ':refs/heads/' + state.refineBranch);
  }
  fs.writeFileSync(dir + '/merged', merged);
}
`);
  chmodSync(fakeGh, 0o755);

  // Return a commit from the simulated agent's worktree without publishing it to origin.
  writeFileSync(join(dir, 'bin/coda-agent'), `#!${process.execPath}
const fs = require('node:fs');
const reply = JSON.parse(process.env.AGENT_REPLY);
fs.writeFileSync(process.env.FIXTURE_DIR + '/agent-args.json', JSON.stringify(process.argv.slice(2)));
if (reply.head) require('node:child_process').execFileSync('git', ['fetch', process.env.FIXTURE_DIR + '/work', reply.head]);
console.log(JSON.stringify(reply));
process.exitCode = Number(process.env.AGENT_EXIT_CODE || 0);
`, { mode: 0o755 });

  const run = stepRunner(fixture, script);
  const state = () => JSON.parse(readFileSync(join(fixture.artifacts, script === refineScript ? 'refine.json' : 'develop.json'), 'utf8'));
  const lead = (decision, expectedError, extra = {}) => run('lead-plan', {
    AGENT_REPLY: JSON.stringify({ session: 'lead', answer: '```json\n' + JSON.stringify(decision) + '\n```' }),
    ...extra,
  }, expectedError);
  return { ...fixture, ghCallsFile, run, lead, state };
}

test('dickda declares its Coda engine and uses supported contributions', () => {
  const { name, displayName, engines, contributes } = JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8'));
  assert.equal(name, 'dickda');
  assert.equal(displayName, 'dickda模式');
  assert.equal(engines.coda, 1);
  for (const key of ['endpoints', 'groups', 'events', 'resources', 'panels', 'extensionPoints', 'extensions']) {
    assert.ok(!Object.hasOwn(contributes, key), `retired contribution: ${key}`);
  }
  assert.deepEqual(contributes.skills, ['skills/dickda']);
  assert.equal(contributes.commands[0].name, 'dickda');
});

test('three roles and four trades default to exact requested models and escalate to senior on difficulty or rejections', () => {
  const settings = loadSettings('{}');
  assert.deepEqual(settings.interactor, { agent: 'antigravity', model: 'gemini-4-neon', effort: 'xhigh' });
  assert.deepEqual(settings.thinker, { agent: 'antigravity', model: 'gemini-4-carbon', effort: 'high' });
  assert.deepEqual(settings.lead, { agent: 'antigravity', model: 'gemini-4-neon', effort: 'xhigh' });

  const archStd = resolveEngineer('architect', { difficulty: 'normal', rejections: 0 }, settings);
  assert.equal(archStd.tier, 'standard');
  assert.equal(archStd.escalated, false);
  assert.deepEqual(archStd.agent, { agent: 'antigravity', model: 'claude-opus-5-5', effort: 'high' });

  const archHard = resolveEngineer('architect', { difficulty: 'hard', rejections: 0 }, settings);
  assert.equal(archHard.tier, 'senior');
  assert.equal(archHard.escalated, true);
  assert.deepEqual(archHard.agent, { agent: 'antigravity', model: 'gemini-4-carbon', effort: 'high' });

  const buildOnce = resolveEngineer('builder', { rejections: 1 }, settings);
  assert.equal(buildOnce.tier, 'standard');
  assert.deepEqual(buildOnce.agent, { agent: 'codex', model: 'gpt-6.2-astra', effort: 'high' });

  const buildEscalated = resolveEngineer('builder', { rejections: 2 }, settings);
  assert.equal(buildEscalated.tier, 'senior');
  assert.equal(buildEscalated.escalated, true);
  assert.deepEqual(buildEscalated.agent, { agent: 'codex', model: 'gpt-6.2-astra', effort: 'max' });

  const verStd = resolveEngineer('verifier', {}, settings);
  assert.deepEqual(verStd.agent, { agent: 'codex', model: 'gpt-6.1-sol', effort: 'high' });
  const verSenior = resolveEngineer('verifier', { tier: 'senior' }, settings);
  assert.deepEqual(verSenior.agent, { agent: 'codex', model: 'gpt-6.1-sol', effort: 'max' });

  for (const role of ROLES) {
    const prompt = rolePrompt(role);
    assert.ok(prompt.length > 80 && prompt.startsWith('# 角色：'), `role prompt missing for ${role}`);
  }
});

test('unified .dickda asset directory initializes cleanly, rejects symlinks, and isolates runtime state in git-dir', t => {
  const { work, commit, git, dir } = createGitRepo(t);
  const cfg = init(work);
  assert.deepEqual(cfg.enabledPrompts, ['general']);

  for (const rel of [
    '.dickda/project.json',
    '.dickda/project.md',
    '.dickda/tasks/TODO_TASK.md',
    '.dickda/tasks/PLAN_5L.md',
    '.dickda/tasks/logs/investigate.md',
    '.dickda/knowledge/Index.md',
    '.dickda/learning/Learning_General.md',
    '.dickda/learning/Learning_Coding.md',
    '.dickda/learning/Learning_Testing.md',
  ]) {
    assert.ok(existsSync(join(work, rel)), `expected ${rel}`);
  }

  const runtimeMarker = runtime(work, 'runs/active.json');
  writeFileSync(runtimeMarker, '{"active":true}\n');
  commit(work, 'commit unified .dickda assets');
  const cloned = join(dir, 'cloned');
  git(dir, 'clone', '-q', work, cloned);
  assert.ok(!existsSync(runtime(cloned, 'runs/active.json')));

  symlinkSync('/tmp', join(work, '.dickda/escape-link'));
  assert.throws(() => inside(work, '.dickda/escape-link/secret'), /符号链接/);
  unlinkSync(join(work, '.dickda/escape-link'));
});

test('init keeps the default dashboard out of the Git index and upgrades existing ignore rules once', t => {
  const { work, git, env } = createGitRepo(t);
  init(work);
  execFileSync(process.execPath, [cliScript, 'dashboard', '--root', work], { env });
  assert.ok(existsSync(join(work, '.dickda/dashboard.tmp.html')));
  writeFileSync(join(work, '.dickda/scratch.tmp'), 'scratch');
  git(work, 'add', '.dickda');
  assert.equal(git(work, 'ls-files', '--', '.dickda/dashboard.tmp.html', '.dickda/scratch.tmp'), '');

  const ignore = join(work, '.dickda/.gitignore');
  const custom = '# local files\r\n/*.tmp\r\n/private.md';
  writeFileSync(ignore, custom);
  init(work);
  init(work);
  assert.equal(readFileSync(ignore, 'utf8'), `${custom}\r\n/*.tmp.html\r\n`);
  assert.equal(git(work, 'check-ignore', '.dickda/dashboard.tmp.html'), '.dickda/dashboard.tmp.html');

  writeFileSync(ignore, '*.tmp.html\n/private.md\n');
  init(work);
  assert.equal(readFileSync(ignore, 'utf8'), '*.tmp.html\n/private.md\n');
});

test('nested lints, code and agent verifiers, and project prompts are discovered in path order', t => {
  const { work } = createGitRepo(t);
  init(work);
  for (const folder of ['lints', 'verifiers', 'prompts']) mkdirSync(join(work, '.dickda', folder, 'nested'));
  const rule = '.dickda/lints/nested/rule.mjs';
  const top = '.dickda/lints/nested.mjs';
  const code = '.dickda/verifiers/nested/check.mjs';
  const spec = '.dickda/verifiers/nested/spec.md';
  writeFileSync(join(work, rule), 'console.log("nested lint");\n');
  writeFileSync(join(work, top), '');
  writeFileSync(join(work, code), 'console.log("nested verifier");\n');
  assert.equal(hasAgentVerifiers(work), false);
  writeFileSync(join(work, spec), '# UI scenario\n');
  assert.equal(hasAgentVerifiers(work), true);

  assert.deepEqual(assetsByKind(work, 'lints').map(a => a.path), [top, rule]);
  assert.deepEqual(assetsByKind(work, 'verifiers').map(a => [a.path, a.track]), [[code, 'code'], [spec, 'agent']]);
  assert.deepEqual(runLints(work).results.map(r => [r.path, r.passed, r.output]), [[top, true, ''], [rule, true, 'nested lint']]);
  const outcome = runCodeVerifiers(work);
  assert.equal(outcome.passed, true);
  assert.deepEqual(outcome.verifiers.map(v => [v.id, v.output]), [[code, 'nested verifier']]);

  writeFileSync(join(work, '.dickda/prompts/nested/team.json'), JSON.stringify(promptTemplate('nested-team')));
  assert.ok(prompts(work).some(p => p.id === 'nested-team' && p.origin === 'project'));
  symlinkSync(join(work, top), join(work, '.dickda/lints/nested/link.mjs'));
  assert.throws(() => runLints(work), /符号链接/);
  symlinkSync(join(work, '.dickda/lints'), join(work, '.dickda/verifiers/nested/link'));
  assert.throws(() => hasAgentVerifiers(work), /符号链接/);
});

test('dual-track verification checks out explicit delivery commit even when main has no .dickda assets', t => {
  const { dir, work, origin, env, git, commit } = createGitRepo(t);
  const mainHead = git(work, 'rev-parse', 'HEAD');

  // Create feature branch on origin with new failing lint/verifier, while a fresh step checkout starts on mainHead!
  git(work, 'checkout', '-b', 'dickda/req-branch', mainHead);
  init(work);
  writeFileSync(join(work, 'app.mjs'), 'export const answer = () => 42; // FORBIDDEN_TOKEN\n');
  writeFileSync(join(work, '.dickda/lints/forbid.mjs'), [
    'import { readFileSync } from "node:fs";',
    'import { join } from "node:path";',
    'if (readFileSync(join(process.env.DICKDA_ROOT, "app.mjs"), "utf8").includes("FORBIDDEN_TOKEN")) process.exit(1);',
  ].join('\n'));
  writeFileSync(join(work, '.dickda/verifiers/ui-check.md'), '# Check UI\n');
  const badDeliveryHead = commit(work, 'delivery commit with lint violation');
  git(work, 'push', '-q', origin, 'dickda/req-branch');

  // Fresh step workspace cloned at main (which has NO .dickda directory at all!)
  const stepCodeWork = join(dir, 'step-code');
  git(dir, 'clone', '-q', origin, stepCodeWork);
  assert.ok(!existsSync(join(stepCodeWork, '.dickda')));

  const fakeAgent = join(dir, 'bin/coda-agent');
  writeFileSync(fakeAgent, `#!${process.execPath}
const args = process.argv.slice(2);
const commitIdx = args.indexOf('--commit');
const commitSha = commitIdx >= 0 ? args[commitIdx + 1] : '';
console.log(JSON.stringify({ session: 'sol-1', answer: '\`\`\`json\\n' + JSON.stringify({ passed: true, summary: 'checked ' + commitSha, evidence: [], findings: [] }) + '\\n\`\`\`' }));
`);
  chmodSync(fakeAgent, 0o755);

  writeFileSync(env.GITHUB_OUTPUT, '');
  const codeRun = spawnSync(process.execPath, [verifyScript, 'code'], {
    cwd: stepCodeWork,
    env: { ...env, COMMIT: badDeliveryHead, RUN_COMMIT: mainHead, BRANCH: 'dickda/req-branch' },
    encoding: 'utf8',
  });
  assert.equal(codeRun.status, 0, codeRun.stderr);
  const codeOut = parseOutputs(env.GITHUB_OUTPUT);
  assert.equal(codeOut.commit, badDeliveryHead);
  assert.equal(codeOut.passed, 'false', 'must run the delivery commit lint instead of skipping on main');

  // Fix violation on req-branch and verify both tracks run on the new delivery SHA
  writeFileSync(join(work, 'app.mjs'), 'export const answer = () => 42;\n');
  const goodDeliveryHead = commit(work, 'fix lint violation');
  git(work, 'push', '-q', origin, 'dickda/req-branch');

  for (const mode of ['code', 'agent']) {
    const freshStep = join(dir, `step-good-${mode}`);
    git(dir, 'clone', '-q', origin, freshStep);
    writeFileSync(env.GITHUB_OUTPUT, '');
    const res = spawnSync(process.execPath, [verifyScript, mode], {
      cwd: freshStep,
      env: { ...env, COMMIT: goodDeliveryHead, RUN_COMMIT: mainHead, BRANCH: 'dickda/req-branch', UI: 'true' },
      encoding: 'utf8',
    });
    assert.equal(res.status, 0, res.stderr);
    const out = parseOutputs(env.GITHUB_OUTPUT);
    assert.equal(out.commit, goodDeliveryHead);
    assert.equal(out.passed, 'true');
  }

  writeFileSync(env.GITHUB_OUTPUT, '');
  const sumRes = spawnSync(process.execPath, [verifyScript, 'summary'], { cwd: stepCodeWork, env, encoding: 'utf8' });
  assert.equal(sumRes.status, 0, sumRes.stderr);
  const sumOut = parseOutputs(env.GITHUB_OUTPUT);
  assert.equal(sumOut.commit, goodDeliveryHead);
  assert.equal(sumOut.passed, 'true');
  assert.equal(checkoutTargetCommit(stepCodeWork, { commit: goodDeliveryHead }), goodDeliveryHead);
});

test('both workflows resolve an explicit device at entry and reuse its group for acceptance', () => {
  for (const [name, condition, next, hold] of [
    ['dickda', '=inputs.device != ""', 'lane', 'accept-hold'],
    ['dickda-verify', '=inputs.ui = true and inputs.device != ""', 'preflight-done', 'device-hold'],
  ]) {
    const { xml, routes } = workflowGraph(name);
    assert.deepEqual(routes('start'), { 'preflight-gate': 'always' });
    assert.match(xml, /<exclusiveGateway id="preflight-gate"[^>]* default="skip-preflight"/);
    assert.deepEqual(routes('preflight-gate'), { 'device-resolve': condition, [next]: 'always' });
    assert.equal(xml.match(/calledElement="resolve-testbed"/g).length, 1);
    assert.match(xml, /<callActivity id="device-resolve"[^>]* calledElement="resolve-testbed">\s*<extensionElements>\s*<coda:param name="device" value="=inputs.device" \/>/);
    assert.deepEqual(routes('device-resolve'), { [next]: 'always' });
    assert.match(xml, new RegExp(`<serviceTask id="${hold}"[^>]*coda:action="hold-group"[^>]*>\\s*<extensionElements>\\s*<coda:param name="group" value="=device-resolve\\.group"`));
  }
  const develop = workflowGraph('dickda');
  assert.deepEqual(develop.routes('lane'), { hold: 'always' });
  assert.deepEqual(develop.routes('accept-device-gate'), { 'accept-hold': '=inputs.device != ""', preview: 'always' });
  const verify = workflowGraph('dickda-verify');
  assert.deepEqual(verify.routes('preflight-done'), { 'tracks-fork': 'always' });
  assert.deepEqual(verify.routes('tracks-fork'), { 'code-verify': 'always', 'agent-gate': 'always' });
});

test('agent-plan checks the requested commit before holding a device and uses the selected verifier tier', t => {
  const { xml, routes } = workflowGraph('dickda-verify');
  assert.deepEqual(routes('agent-sub-start'), { 'agent-plan': 'always' });
  assert.deepEqual(routes('agent-plan'), { 'specs-gate': 'always' });
  assert.deepEqual(routes('specs-gate'), { 'device-gate': '=agent-plan.needed = true', 'agent-sub-end': 'always' });
  assert.deepEqual(routes('device-gate'), { 'device-hold': '=inputs.device != ""', 'agent-verify': 'always' });
  assert.deepEqual(routes('device-hold'), { 'agent-verify': 'always' });
  const dual = workflowGraph('dickda').xml.match(/<callActivity id="dual-verify"[\s\S]*?<\/callActivity>/)[0];
  for (const [input, key] of [['verifier', 'VERIFIER'], ['verifierSenior', 'VERIFIER_SENIOR']]) {
    assert.match(xml, new RegExp(`<coda:input name="${input}"[^>]*type="agent"`));
    assert.ok(xml.includes(`<coda:env name="${key}" value="=inputs.${input}"`));
    assert.ok(dual.includes(`<coda:param name="${input}" value="=inputs.${input}"`));
  }

  const fixture = createGitRepo(t);
  const { work, dir, git, commit, artifacts } = fixture;
  const run = stepRunner(fixture, verifyScript);
  init(work);
  writeFileSync(join(work, '.dickda/verifiers/test.sh'), 'exit 0\n');
  const codeOnly = commit(work, 'code verifier only');
  git(work, 'checkout', '-b', 'candidate');
  mkdirSync(join(work, '.dickda/verifiers/ui'));
  writeFileSync(join(work, '.dickda/verifiers/ui/login.md'), 'Check login');
  const withUi = commit(work, 'add nested UI spec');
  git(work, 'push', 'origin', 'candidate');
  const report = () => JSON.parse(readFileSync(join(artifacts, 'agent-verify.json')));
  const target = { BRANCH: 'candidate', DEVICE: 'phone', RUN_COMMIT: codeOnly };

  assert.deepEqual(run('agent-plan', { ...target, COMMIT: codeOnly }), { needed: 'false', commit: codeOnly });
  assert.equal(report().commit, codeOnly);
  assert.equal(report().skipped, true);
  assert.equal(report().passed, true);
  run('code', target);
  assert.match(run('summary').report, /无 Agent\/UI 规约/);
  assert.deepEqual(run('agent-plan', { ...target, COMMIT: withUi }), { needed: 'true', commit: withUi });

  writeFileSync(join(dir, 'bin/coda-agent'), `#!${process.execPath}
require('node:fs').writeFileSync(process.env.FIXTURE_DIR + '/agent-args.json', JSON.stringify(process.argv.slice(2)));
console.log(JSON.stringify({ answer: '\`\`\`json\\n{"passed":true}\\n\`\`\`' }));
`, { mode: 0o755 });
  for (const [tier, model] of [['standard', 'ui-standard'], ['senior', 'ui-senior']]) {
    const result = run('agent', {
      ...target, COMMIT: withUi, TIER: tier,
      VERIFIER: JSON.stringify({ agent: 'custom', model: 'ui-standard' }),
      VERIFIER_SENIOR: JSON.stringify({ agent: 'custom', model: 'ui-senior' }),
    });
    assert.equal(result.commit, withUi);
    assert.equal(result.passed, 'true');
    const args = JSON.parse(readFileSync(join(dir, 'agent-args.json')));
    assert.equal(args[args.indexOf('--model') + 1], model);
    assert.equal(report().skipped, false);
  }
});

test('verifier worker failures and missing/failed review-commit calls never silently pass', t => {
  const { work, commit } = createGitRepo(t);
  init(work);
  const baseTip = commit(work, 'base');

  // 1) Verifier worker returning passed=false or missing JSON must be rejected and counted toward senior escalation
  const failedEval = evaluateVerifierAnswer('```json\n{"passed": false, "summary": "按钮点击无响应", "findings": []}\n```');
  assert.equal(failedEval.valid, true);
  assert.equal(failedEval.passed, false);

  const missingJsonEval = evaluateVerifierAnswer('Looks fine to me without structured JSON.');
  assert.equal(missingJsonEval.valid, false);
  assert.equal(missingJsonEval.passed, false);

  const ledger = { 'ver-ui': { id: 'ver-ui', trade: 'verifier', rejections: 1 } };
  const batch = enrichDispatchBatch([
    { id: 'ver-ui', trade: 'verifier', title: 'UI Regression Check', task: 'run ui check' },
  ], ledger);

  const integrated = integrateWorkerResults(work, baseTip, [
    { ...batch[0], status: 'rejected', passed: false, summary: '场景失败', findings: [], error: '场景失败' },
  ], ledger);

  assert.equal(integrated.ledger['ver-ui'].status, 'rejected');
  assert.equal(integrated.ledger['ver-ui'].rejections, 2);
  assert.equal(integrated.ledger['ver-ui'].nextTier, 'senior');
  assert.equal(integrated.rejected.length, 1);
  assert.match(integrated.rejected[0].reason, /场景失败/);

  // 2) Verification gate must reject empty REVIEW={}, INCOMPLETE, mismatched review.head, or mismatched verifyCommit
  const head = 'b'.repeat(40);
  assert.equal(evaluateVerificationGate({ head, verifyCommit: head, verifyPassed: true, review: {} }).route, 'retry');
  assert.equal(evaluateVerificationGate({ head, verifyCommit: head, verifyPassed: true, review: null }).route, 'retry');
  assert.equal(evaluateVerificationGate({ head, verifyCommit: head, verifyPassed: true, review: { head: 'c'.repeat(40), decision: 'APPROVE' } }).route, 'retry');
  assert.equal(evaluateVerificationGate({ head, verifyCommit: head, verifyPassed: true, review: { head, decision: 'INCOMPLETE', line: 'timeout' } }).route, 'retry');
  assert.equal(evaluateVerificationGate({ head, verifyCommit: 'd'.repeat(40), verifyPassed: true, review: { head, decision: 'APPROVE' } }).route, 'lead');
  assert.equal(evaluateVerificationGate({ head, verifyCommit: head, verifyPassed: true, review: { head, decision: 'REQUEST_CHANGES', line: 'bug' } }).route, 'lead');
  assert.equal(evaluateVerificationGate({ head, verifyCommit: head, verifyPassed: true, review: { head, decision: 'APPROVE', line: 'ok' } }).route, 'pr');
  assert.equal(evaluateVerificationGate({ head, verifyCommit: head, verifyPassed: true, review: { head, decision: 'COMMENT', line: 'nit only' } }).route, 'pr');
});

test('concurrent multi-trade dispatch integrates non-conflicting commits, checks spec-lock, and escalates conflicts', t => {
  const { work, git, commit } = createGitRepo(t);
  init(work);
  writeFileSync(join(work, '.dickda/lints/no-bad.mjs'), 'process.exit(0);\n');
  const baseTip = commit(work, 'base state');

  git(work, 'checkout', '-b', 'job-tamper', baseTip);
  writeFileSync(join(work, '.dickda/lints/no-bad.mjs'), '// tampered\n');
  const tamperHead = commit(work, 'tampered');
  assert.equal(checkSpecLock(work, baseTip, tamperHead).ok, false);

  git(work, 'checkout', '-b', 'job-arch', baseTip);
  writeFileSync(join(work, '.dickda/lints/arch.mjs'), '// arch lint\nprocess.exit(0);\n');
  const archHead = commit(work, 'arch spec');

  git(work, 'checkout', '-b', 'job-a', baseTip);
  writeFileSync(join(work, 'module-a.mjs'), 'export const a = 1;\n');
  const headA = commit(work, 'impl module a');

  git(work, 'checkout', '-b', 'job-b1', baseTip);
  writeFileSync(join(work, 'app.mjs'), 'export const answer = () => 100;\n');
  const headB1 = commit(work, 'impl b1');

  git(work, 'checkout', '-b', 'job-conflict', baseTip);
  writeFileSync(join(work, 'app.mjs'), 'export const answer = () => 999;\n');
  const headConflict = commit(work, 'impl conflict');

  git(work, 'checkout', 'main');

  const ledger = { 'impl-conflict': { id: 'impl-conflict', trade: 'builder', rejections: 1 } };
  const batch = enrichDispatchBatch([
    { id: 'arch-1', trade: 'architect', title: 'Add arch lint', task: 'lint' },
    { id: 'impl-a', trade: 'builder', title: 'Module A', task: 'mod a' },
    { id: 'impl-b1', trade: 'builder', title: 'Update app', task: 'app' },
    { id: 'impl-conflict', trade: 'builder', title: 'Conflicting app edit', task: 'conflict' },
    { id: 'ver-1', trade: 'verifier', title: 'Red team check', task: 'verify' },
  ], ledger);

  const integrated = integrateWorkerResults(work, baseTip, [
    { ...batch[0], status: 'succeeded', head: archHead },
    { ...batch[1], status: 'succeeded', head: headA },
    { ...batch[2], status: 'succeeded', head: headB1 },
    { ...batch[3], status: 'succeeded', head: headConflict },
    { ...batch[4], status: 'succeeded', passed: true, summary: 'Checked', findings: [{ level: 'nit', title: 'Minor naming', detail: 'ok' }] },
  ], ledger);

  assert.equal(integrated.changed, true);
  assert.equal(integrated.landed.length, 3);
  assert.equal(integrated.rejected.length, 1);
  assert.equal(integrated.rejected[0].id, 'impl-conflict');
  assert.equal(integrated.rejected[0].rejections, 2);
  assert.equal(integrated.rejected[0].nextTier, 'senior');
  assert.equal(integrated.findings.length, 1);

  const nextWave = enrichDispatchBatch([
    { id: 'impl-conflict', trade: 'builder', title: 'Retry conflicting app edit', task: 'retry' },
  ], integrated.ledger);
  assert.equal(nextWave[0].tier, 'senior');
  assert.equal(nextWave[0].escalated, true);
  assert.equal(nextWave[0].agent.effort, 'max');
});

test('spec lock preserves requirement specs before and after merging new upstream specs', t => {
  const { work, git, commit } = createGitRepo(t);
  init(work);
  const arch = '.dickda/lints/arch.mjs';
  const verifier = '.dickda/verifiers/arch.md';
  writeFileSync(join(work, verifier), '# Original checks\n');
  const ancestor = commit(work, 'original verifier');
  git(work, 'checkout', '-b', 'requirement');
  writeFileSync(join(work, arch), '// architecture rule\n');
  writeFileSync(join(work, verifier), '# Architecture checks\n');
  const base = commit(work, 'architecture specs');

  rmSync(join(work, arch));
  git(work, 'checkout', ancestor, '--', verifier);
  const reverted = commit(work, 'worker restores the old upstream specs');
  assert.deepEqual(checkSpecLock(work, base, reverted, { upstreamCommit: ancestor }), { ok: false, violations: [arch, verifier] });

  git(work, 'checkout', 'main');
  writeFileSync(join(work, '.dickda/verifiers/upstream.md'), '# Upstream checks\n');
  const upstream = commit(work, 'upstream adds a verifier');
  git(work, 'checkout', '-b', 'worker', base);
  git(work, 'merge', '--no-ff', '-m', 'merge upstream specs', upstream);
  const merged = git(work, 'rev-parse', 'HEAD');
  assert.deepEqual(checkSpecLock(work, base, merged, { upstreamCommit: upstream }), { ok: true, violations: [] });

  rmSync(join(work, arch));
  const dropped = commit(work, 'worker drops the architecture lint');
  assert.deepEqual(checkSpecLock(work, base, dropped, { upstreamCommit: upstream }), { ok: false, violations: [arch] });
});

test('spec lock requires upstream changes and rejects conflicting edits to the same spec', t => {
  const { work, git, commit } = createGitRepo(t);
  init(work);
  const lint = '.dickda/lints/upstream.mjs';
  const removed = '.dickda/verifiers/old.md';
  writeFileSync(join(work, removed), '# Old spec\n');
  const base = commit(work, 'shared specs');
  git(work, 'checkout', '-b', 'worker');
  writeFileSync(join(work, 'job.mjs'), 'export const ready = true;\n');
  const worker = commit(work, 'worker implementation');
  git(work, 'checkout', 'main');
  writeFileSync(join(work, lint), '// upstream rule\n');
  rmSync(join(work, removed));
  const upstream = commit(work, 'upstream adds a lint and removes an old verifier');

  const strict = { ok: false, violations: [lint, removed] };
  assert.deepEqual(checkSpecLock(work, base, upstream, { upstreamCommit: worker }), strict);
  git(work, 'checkout', 'worker');
  git(work, 'merge', '--no-ff', '-m', 'merge upstream', upstream);
  const merged = git(work, 'rev-parse', 'HEAD');
  assert.deepEqual(checkSpecLock(work, base, merged), strict);
  assert.deepEqual(checkSpecLock(work, base, merged, { upstreamCommit: upstream }), { ok: true, violations: [] });

  writeFileSync(join(work, lint), '// different rule\n');
  const changed = commit(work, 'worker edits upstream rule');
  assert.deepEqual(checkSpecLock(work, base, changed, { upstreamCommit: upstream }), { ok: false, violations: [lint] });

  git(work, 'checkout', '-b', 'other-base', base);
  git(work, 'checkout', upstream, '--', lint);
  const matching = commit(work, 'requirement adds the same lint as upstream');
  git(work, 'checkout', changed, '--', lint);
  const conflicting = commit(work, 'requirement changes the lint differently');
  git(work, 'merge', '-s', 'ours', '-m', 'keep requirement specs', upstream);
  const keptBase = git(work, 'rev-parse', 'HEAD');
  assert.deepEqual(checkSpecLock(work, conflicting, keptBase, { upstreamCommit: upstream }), strict);

  git(work, 'restore', '--source', upstream, '--', lint, removed);
  const keptUpstream = commit(work, 'use upstream specs');
  assert.deepEqual(checkSpecLock(work, conflicting, keptUpstream, { upstreamCommit: upstream }), { ok: false, violations: [lint] });
  assert.deepEqual(checkSpecLock(work, matching, keptUpstream, { upstreamCommit: upstream }), { ok: true, violations: [] });
});

test('per-job logs merge cleanly and remember archives all valid Markdown for Refine', t => {
  const { work, git, commit } = createGitRepo(t);
  init(work);
  const logDir = join(work, '.dickda/tasks/logs');
  const shared = join(logDir, 'investigate.md');
  const base = commit(work, 'seed project assets');
  git(work, 'checkout', '-b', 'impl-a', base);
  writeFileSync(join(logDir, 'impl-a.md'), 'Found A.\n');
  const headA = commit(work, 'record experiment A');
  git(work, 'checkout', '-b', 'impl-b', base);
  writeFileSync(join(logDir, 'impl-b.md'), 'Found B.\n');
  const headB = commit(work, 'record experiment B');
  const mergedTree = git(work, 'merge-tree', '--write-tree', headA, headB);
  git(work, 'checkout', mergedTree, '--', '.dickda/tasks/logs');

  mkdirSync(join(logDir, 'impl'));
  writeFileSync(join(logDir, 'impl/a.md'), 'Nested A.\n');
  writeFileSync(join(logDir, 'empty.md'), ' \n');
  writeFileSync(join(logDir, 'template.md'), INVESTIGATE_MARKER);
  writeFileSync(shared, `\uFEFF  ${INVESTIGATE_MARKER} \n`);
  const time = new Date(2026, 10, 24, 12, 0, 0);
  const archived = remember(work, time);
  assert.equal(archived.archived, true);
  const ctx = buildRefineContext(work);
  assert.equal(ctx.archive, archived.path);
  const files = Object.fromEntries(ctx.files.map(f => [f.name, f.body]));
  assert.equal(files['log-impl-a.md'], '# impl-a.md\n\nFound A.\n');
  assert.equal(files['log-impl-b.md'], '# impl-b.md\n\nFound B.\n');
  assert.ok(ctx.files.some(f => !f.name.includes('/') && f.name.endsWith('.md') && f.body === '# impl/a.md\n\nNested A.\n'));
  for (const name of ['TODO_TASK.md', 'PLAN_5L.md']) {
    assert.equal(files[name], readFileSync(join(work, '.dickda/tasks', name), 'utf8'));
  }
  assert.equal(ctx.files.length, 5);
  for (const name of ['impl-a.md', 'impl-b.md', 'impl/a.md']) assert.ok(!existsSync(join(logDir, name)));
  assert.equal(readFileSync(shared, 'utf8'), INVESTIGATE_MARKER);
  assert.equal(readFileSync(join(logDir, 'empty.md'), 'utf8'), ' \n');
  assert.equal(readFileSync(join(logDir, 'template.md'), 'utf8'), INVESTIGATE_MARKER);
  writeFileSync(shared, ' \n');
  assert.deepEqual(remember(work), { archived: false });

  const legacy = '\uFEFF# Investigation\nA later experiment.\n';
  writeFileSync(shared, legacy);
  const later = remember(work, time);
  assert.notEqual(later.path, archived.path);
  assert.equal(readFileSync(join(work, later.path, 'investigate.md'), 'utf8'), legacy);
  assert.equal(readFileSync(shared, 'utf8'), INVESTIGATE_MARKER);
});

test('remember rejects linked logs and Refine reads nested archive Markdown without following links', t => {
  const { work } = createGitRepo(t);
  init(work);
  const logs = join(work, '.dickda/tasks/logs');
  const job = join(logs, 'job.md');
  writeFileSync(job, 'Experiment\n');
  symlinkSync(job, join(logs, 'link.md'));
  assert.throws(() => remember(work), /符号链接/);
  assert.deepEqual(backups(work), []);
  assert.equal(readFileSync(job, 'utf8'), 'Experiment\n');
  unlinkSync(join(logs, 'link.md'));

  const archive = remember(work).path;
  const nested = join(work, archive, 'legacy');
  mkdirSync(nested);
  writeFileSync(join(nested, 'job.md'), 'Historical log\n');
  symlinkSync(join(work, '.dickda/knowledge/Index.md'), join(nested, 'linked.md'));
  symlinkSync(join(work, '.dickda/knowledge'), join(nested, 'linked-dir'));
  const nestedFiles = buildRefineContext(work).files.filter(f => f.name.startsWith('legacy/'));
  assert.deepEqual(nestedFiles, [{ name: 'legacy/job.md', body: 'Historical log\n' }]);
});

test('prose refinement removes obsolete lines across learning files and applies targeted notes and knowledge', t => {
  const { work } = createGitRepo(t);
  init(work);
  const learning = join(work, '.dickda/learning');
  const names = ['Learning_General.md', 'Learning_Coding.md', 'Learning_Testing.md', 'Learning_Team.md'];
  const keep = '# Rules\n- Keep this [4]\n';
  for (const name of names) writeFileSync(join(learning, name), `${keep}- Obsolete manual check [3]\n`);
  const knowledge = { path: 'knowledge/architecture/boundaries.md', content: '# Module boundaries\n' };
  const diagnosis = normalizeDiagnosis({
    obsoleteProse: ['Obsolete manual check'],
    learningUpdates: [
      'Common practice', { text: 'Common practice' }, 'Keep this',
      { file: 'Learning_Coding.md', text: 'Coding practice' },
      { file: 'Learning_Testing.md', text: 'Testing practice' },
    ],
    knowledgeUpdates: [knowledge],
  });
  applyProseRefinements(work, diagnosis);
  applyProseRefinements(work, diagnosis);
  assert.deepEqual(names.map(name => readFileSync(join(learning, name), 'utf8')), [
    `${keep}- Common practice [1]\n`, `${keep}- Coding practice [1]\n`, `${keep}- Testing practice [1]\n`, keep,
  ]);
  assert.equal(readFileSync(join(work, '.dickda', knowledge.path), 'utf8'), knowledge.content);

  symlinkSync(learning, join(work, '.dickda/knowledge/link'));
  for (const path of ['learning/Learning_Team.md', 'knowledge/../learning/Learning_Team.md', 'knowledge/link/Learning_Team.md']) {
    assert.throws(() => applyProseRefinements(work, { knowledgeUpdates: [{ path, content: 'invalid' }] }), /知识更新|相对路径|符号链接/);
  }
  assert.equal(readFileSync(join(learning, 'Learning_Team.md'), 'utf8'), keep);
});

test('prose refinement writes custom learning documents and rejects invalid filenames and symlinks', t => {
  const { work } = createGitRepo(t);
  init(work);
  const learning = join(work, '.dickda/learning');
  const addNote = file => applyProseRefinements(work, { learningUpdates: [{ file, text: 'Team practice' }] });
  addNote('Learning_Team.md');
  assert.equal(readFileSync(join(learning, 'Learning_Team.md'), 'utf8'), '- Team practice [1]\n');
  for (const file of ['Notes.md', 'Learning_.md', '../Learning_Team.md', 'Learning_Team/Notes.md', 'Learning_Team\\Notes.md']) {
    assert.throws(() => addNote(file), /无效的经验文档/);
  }
  symlinkSync(join(learning, 'Learning_Team.md'), join(learning, 'Learning_Link.md'));
  assert.throws(() => addNote('Learning_Link.md'), /符号链接/);
});

test('development workflow routes both plan decisions, milestones, dual failures and adjudicated reviews', () => {
  const { xml, routes, card } = workflowGraph('dickda');
  assert.deepEqual(routes('think-gate'), {
    'lead-plan': '=inputs.fast = true', 'plan-present': '=inputs.fast = false and seed.hasPlan = true', think: 'always',
  });
  assert.deepEqual(routes('think'), { 'plan-present': 'always' });
  assert.deepEqual(routes('plan-present'), { 'present-gate': 'always' });
  assert.deepEqual(routes('present-gate'), { 'plan-feedback': '=plan-present.chose.revise', 'plan-confirm': 'always' });
  assert.doesNotMatch(card('brief') + card('plan-present'), /coda:wake="false"|coda:assignee="user"/);
  assert.match(card('plan-present'), /lane\.reqBranch[\s\S]*?think.head[\s\S]*?PLAN_5L\.md[\s\S]*?seed.preview[\s\S]*?think.preview/);
  assert.match(card('plan-present'), /id="recommend"[^>]*primary="true" note="required"/);
  assert.match(card('plan-present'), /id="revise"[^>]*note="required"/);
  assert.match(card('plan-confirm'), /assignee="user"[\s\S]*plan-present.note[\s\S]*seed.preview[\s\S]*think.preview/);
  assert.match(card('plan-confirm'), /id="start"[^>]*primary="true"/);
  assert.match(card('plan-confirm'), /id="revise"[^>]*note="required"/);
  assert.match(card('plan-confirm'), /id="stop" name="暂不开工"/);
  assert.deepEqual(routes('confirm-gate'), {
    'lead-plan': '=plan-confirm.chose.start', 'plan-feedback': '=plan-confirm.chose.revise', 'record-stop': 'always',
  });
  assert.match(xml, /name="FEEDBACK" value="=if plan-present.chose.revise then plan-present.note else plan-confirm.note"/);
  assert.deepEqual(routes('plan-feedback'), { think: 'always' });
  assert.deepEqual(routes('record-stop'), { stopped: 'always' });
  assert.match(xml, /<coda:output name="reason" value="=record-stop.reason"/);
  assert.deepEqual(routes('brief-valid'), { brief: '=brief-parse.route = "again"', seed: 'always' });
  assert.equal(routes('lead-route')['milestone-gate'], 'always');
  assert.deepEqual(routes('milestone-gate'), {
    'tell-milestone': '=lead-plan.session != "" and lead-plan.milestone != ""', 'run-jobs': 'always',
  });
  assert.match(xml, /coda:action="tell-session">[\s\S]*?name="session" value="=lead-plan.session"[\s\S]*?name="text"[^>]+lead-plan.milestone/);
  assert.deepEqual(routes('tell-milestone'), { 'run-jobs': 'always' });
  assert.deepEqual(routes('prepare-verify'), { 'rebuttal-gate': 'always' });
  assert.deepEqual(routes('rebuttal-gate'), { pr: '=prepare-verify.skipReview', 'dual-verify': 'always' });
  assert.match(xml, /attachedToRef="dual-verify">\s*<errorEventDefinition/);
  assert.deepEqual(routes('dual-verify-error'), { 'dual-call-lost': 'always' });
  assert.deepEqual(routes('dual-call-lost'), { 'lead-plan': 'always' });
  assert.deepEqual(routes('dual-verify'), { 'dual-result': 'always' });
  assert.deepEqual(routes('dual-result'), { 'verified-check': '=not(dual-verify.passed)', 'final-review': 'always' });
  assert.match(xml, /name="previous" value="=prepare-verify.previous"/);
  assert.match(xml, /name="VERIFY_EVIDENCE" value="=dual-verify.evidence"/);
  assert.match(xml, /name="VERIFY_FINDINGS" value="=dual-verify.findings"/);
  assert.equal(routes('verified-gate')['lead-plan'], '=verified-check.route = "lead"');
  assert.match(card('approve'), /approval-check.summary/);
});

for (const [script, step] of [[developScript, 'lane'], [refineScript, 'collect']]) {
  test(`${step} rejects a non-default base before fetching it or writing workflow state`, t => {
    const { run, artifacts } = workflowFixture(t, script);
    assert.deepEqual(run(step, { BASE: 'release' }, /仅允许以仓库默认分支 main 作为目标分支.*release/), {});
    assert.ok(!existsSync(join(artifacts, script === developScript ? 'develop.json' : 'refine.json')));
  });
}

test('remote-only starting branch supplies the original task and a bounded preview of every plan layer', t => {
  const { work, origin, dir, git, commit, run, state } = workflowFixture(t);
  init(work);
  const todo = '.dickda/tasks/TODO_TASK.md';
  const plan = '.dickda/tasks/PLAN_5L.md';
  const goal = '保留原换行和原边界。\n\n- 仅验收指定入口。';
  const original = `# 原需求\n\n${goal}\n\n`;
  writeFileSync(join(work, todo), original);
  writeFileSync(join(work, plan), blueprint.replace('架构边界', '架构边界'.repeat(1500)));
  const start = commit(work, 'existing task and five-layer plan');
  git(work, 'push', 'origin', `${start}:refs/heads/planned`);
  const lane = run('lane', { BRANCH: 'planned', GOAL: '', TITLE: '' });
  assert.equal(lane.needBrief, 'false');
  assert.equal(state().title, '原需求');
  assert.equal(state().goal, goal);
  const seed = run('seed');
  assert.equal(seed.hasPlan, 'true');
  assert.equal(seed.head, start);
  assert.equal(git(origin, 'rev-parse', `${lane.reqBranch}:${todo}`), git(work, 'hash-object', todo));
  assert.ok(seed.preview.length < 3600);
  assert.match(seed.preview, /架构边界[\s\S]*…[\s\S]*Lint 规则[\s\S]*验证用例[\s\S]*并发工单[\s\S]*人工锚点/);

  for (const note of ['交互者要求补充验收入口', '用户要求改动并发边界']) {
    run('plan-feedback', { FEEDBACK: note });
    assert.equal(state().planFeedback, note);
    writeFileSync(join(work, plan), blueprint + '\n' + note);
    const head = commit(work, 'revise plan');
    const revised = run('think', { AGENT_REPLY: JSON.stringify({ session: 'think', head }) });
    assert.equal(revised.head, head);
    assert.ok(revised.preview.includes(note));
    assert.ok(readFileSync(join(dir, 'tmp/thinker.md'), 'utf8').includes('交互者/用户修订意见\n' + note));
    assert.equal(state().planFeedback, '');
  }
  const summary = join(dir, 'summary');
  const stop = run('stopped', { REASON: '等产品确认范围', GITHUB_STEP_SUMMARY: summary });
  assert.equal(state().stopReason, stop.reason);
  assert.match(readFileSync(summary, 'utf8'), /等产品确认范围/);
  assert.equal(git(origin, 'rev-parse', lane.reqBranch), state().head);
  assert.match(run('stopped', { REASON: '' }).reason, /暂不开工/);
});

test('seed preserves a plan for a matching explicit goal and resets it for a new goal', t => {
  const { dir, work, origin, git, commit, run } = workflowFixture(t);
  init(work);
  const todo = '.dickda/tasks/TODO_TASK.md';
  const plan = '.dickda/tasks/PLAN_5L.md';
  const defaultPlan = git(work, 'hash-object', plan);
  const oldGoal = '保留原目标。\n\n- 验收旧入口。';
  const original = `# 已合入的需求\n\n${oldGoal}\n\n`;
  writeFileSync(join(work, todo), original);
  writeFileSync(join(work, plan), blueprint);
  const start = commit(work, 'merged task and plan');
  git(work, 'push', 'origin', 'main');

  function seed(id, goal) {
    const env = { CODA_ARTIFACTS: join(dir, id), GITHUB_RUN_ID: id };
    run('lane', { ...env, GOAL: goal, TITLE: '本次需求' });
    return run('seed', env);
  }
  for (const [id, goal] of [['same-body', oldGoal.replaceAll('\n', '\r\n')], ['same-file', original]]) {
    const reused = seed(id, goal);
    assert.equal(reused.hasPlan, 'true');
    assert.equal(reused.head, start);
  }
  const goal = '为新入口增加验收。';
  const seeded = seed('new-goal', goal);
  assert.equal(seeded.hasPlan, 'false');
  assert.equal(seeded.preview, '');
  assert.equal(git(origin, 'show', `${seeded.head}:${todo}`), `# 本次需求\n\n${goal}`);
  assert.equal(git(origin, 'rev-parse', `${seeded.head}:${plan}`), defaultPlan);
});

test('empty templates return to brief, and a changed brief replaces the branch task and plan', t => {
  const { work, origin, git, commit, run } = workflowFixture(t);
  const todo = '.dickda/tasks/TODO_TASK.md';
  const plan = '.dickda/tasks/PLAN_5L.md';
  init(work);
  git(work, 'push', 'origin', `${commit(work, 'empty templates')}:main`);
  const lane = run('lane', { GOAL: '', TITLE: '' });
  assert.equal(lane.needBrief, 'true');
  assert.equal(run('brief', { BRIEF: '{"note":" "}' }).route, 'again');
  writeFileSync(join(work, todo), '# 分支原文\n\n已有边界\n');
  writeFileSync(join(work, plan), blueprint);
  git(work, 'push', 'origin', `${commit(work, 'task written on the branch')}:${lane.reqBranch}`);
  const seed = run('seed');
  assert.equal(seed.hasPlan, 'true');
  assert.equal(git(origin, 'show', `${seed.head}:${todo}`), '# 分支原文\n\n已有边界');
  assert.equal(run('brief', { BRIEF: '{"note":"新标题\\n新目标"}' }).route, 'ok');
  const updated = run('seed');
  assert.equal(updated.hasPlan, 'false');
  assert.equal(git(origin, 'rev-parse', `${updated.head}:${plan}`), git(origin, 'rev-parse', `main:${plan}`));
  assert.equal(git(origin, 'show', `${updated.head}:${todo}`), '# 新标题\n\n新目标');
});

test('a same-head review needs a reason per finding, then goes to the PR and approval card with both verdicts', t => {
  const { run, lead, state, artifacts } = workflowFixture(t);
  run('lane', { GOAL: '交付新入口' });
  const { head } = run('seed');
  const findings = [
    { id: '#1', level: 'must', kind: 'contract', title: '入口覆盖', location: 'app.mjs:1', detail: '入口可能未检查' },
    { id: '#2', level: 'must', kind: 'test-quality', title: '入口覆盖', location: 'test.mjs', detail: '未找到回归用例' },
  ];
  const dual = {
    VERIFY_COMMIT: head, VERIFY_PASSED: 'true', VERIFY_REPORT: '双轨已完成',
    VERIFY_EVIDENCE: '[{"path":"entry.png","step":3}]', VERIFY_FINDINGS: '[{"level":"nit","detail":"按钮文案"}]',
  };
  const review = { head, decision: 'REQUEST_CHANGES', line: 'Sol 要求修改', report: '检查入口并补测试', findings: JSON.stringify(findings) };
  assert.equal(run('verified', { ...dual, REVIEW: JSON.stringify(review) }).route, 'lead');
  assert.equal(run('prepare-verify').skipReview, 'false');
  lead({ action: 'verify' }, /REQUEST_CHANGES.*ignoredFindings/);
  lead({ action: 'verify', ignoredFindings: [{ id: '#1', reason: '  ' }] }, /ignoredFindings.*reason/);
  const first = { id: '#1', title: '入口覆盖', reason: '入口统一调用 validateEntry，见 app.mjs:4' };
  lead({ action: 'verify', ignoredFindings: [first] }, /缺少 #2/);
  assert.equal(run('prepare-verify').skipReview, 'false');
  const second = { title: '入口覆盖', reason: 'test.mjs:12 覆盖了入口回归' };
  assert.equal(lead({ action: 'verify', ignoredFindings: [first, second] }).route, 'verify');
  assert.equal(state().rebuttedReviewHead, head);
  assert.equal(run('archive-delivery').head, head);
  assert.equal(run('prepare-verify').skipReview, 'true');
  const pr = run('pr');
  assert.equal(pr.summary, readFileSync(join(artifacts, 'pull-request.md'), 'utf8'));
  assert.equal(run('approval-check').summary, pr.summary);
  for (const detail of ['REQUEST_CHANGES', review.line, review.report, first.reason, second.reason, '双轨已完成', 'entry.png', '按钮文案']) {
    assert.ok(pr.summary.includes(detail), detail);
  }

  const failure = run('verified', { ...dual, VERIFY_PASSED: 'false', VERIFY_REPORT: '这次入口失败', REVIEW: JSON.stringify(review) });
  assert.equal(failure.route, 'lead');
  assert.doesNotMatch(failure.reason, /独立代码审查/);
  for (const detail of ['这次入口失败', 'entry.png', '按钮文案']) assert.ok(state().pendingFeedback.includes(detail));
  assert.equal(state().verifiedHead, '');
  assert.equal(run('prepare-verify').skipReview, 'false');
  const lost = run('verified', { VERIFY_REPORT: 'dickda-verify 调用异常，请查看子流程' });
  assert.equal(lost.route, 'lead');
  assert.match(state().pendingFeedback, /调用异常/);
});

test('incremental review numbers new musts, preserves upheld ids and falls back for incomplete findings', t => {
  const { work, git, commit, run, lead } = workflowFixture(t);
  const lane = run('lane', { GOAL: '增量复评' });
  let { head } = run('seed');
  git(work, 'fetch', 'origin', lane.reqBranch);
  git(work, 'checkout', '--detach', 'FETCH_HEAD');
  function advance() {
    writeFileSync(join(work, 'fix.txt'), head);
    head = commit(work, 'address review');
    git(work, 'push', 'origin', `${head}:refs/heads/${lane.reqBranch}`);
    assert.equal(lead({ action: 'verify' }).route, 'verify');
    const prep = run('prepare-verify');
    assert.equal(prep.head, head);
    assert.equal(prep.skipReview, 'false');
    return prep;
  }
  function reviewed(findings, previous = '', resolutions = []) {
    assert.equal(run('verified', {
      VERIFY_COMMIT: head, VERIFY_PASSED: 'true', PREVIOUS: previous,
      REVIEW: JSON.stringify({ head, decision: 'REQUEST_CHANGES', findings: JSON.stringify(findings), resolutions: JSON.stringify(resolutions) }),
    }).route, 'lead');
  }
  const must = { level: 'must', kind: 'contract', title: '入口', location: 'a:1', detail: '详情' };
  const second = { ...must, id: '#2', title: '出口' };
  const third = { ...must, title: '新增意见' };
  const original = head;
  reviewed([must, { level: 'nit', title: '风格' }, second]);
  const first = advance();
  assert.equal(first.base, original);
  const numbered = { ...must, id: `${original.slice(0, 12)}-1` };
  assert.deepEqual(JSON.parse(first.previous), [numbered, second]);
  reviewed([third], first.previous, [{ id: numbered.id, status: 'upheld', reason: '仍有触发路径' }, { id: '#2', status: 'resolved' }]);
  const next = advance();
  assert.equal(next.base, first.head);
  assert.deepEqual(JSON.parse(next.previous), [numbered, { ...third, id: `${first.head.slice(0, 12)}-2` }]);
  reviewed([{ ...must, kind: '' }, second]);
  const full = advance();
  assert.equal(full.base, lane.baseCommit);
  assert.equal(full.previous, '');
});

test('cancelled coding jobs retain strict descendant commits for redispatch without integrating them', t => {
  const { work, origin, git, commit, run, lead, state } = workflowFixture(t);
  const { reqBranch } = run('lane', { GOAL: '实现入口' });
  const { head: base } = run('seed');
  const sibling = commit(work, 'work on another branch');
  git(work, 'fetch', 'origin', reqBranch);
  git(work, 'checkout', '--detach', 'FETCH_HEAD');
  writeFileSync(join(work, 'entry.mjs'), 'export const ready = false;\n');
  const partial = commit(work, 'partial implementation');
  const job = { id: 'entry', trade: 'builder', title: '入口', task: '实现入口' };
  lead({ action: 'dispatch', jobs: [job, { ...job, id: 'check', trade: 'verifier' }] });
  const cancel = (id, head) => run('worker', {
    JOB_ID: id, AGENT_EXIT_CODE: '130', AGENT_REPLY: JSON.stringify({ session: 'engineer', head }),
  });
  for (const head of [base, sibling]) assert.equal(cancel(job.id, head).status, 'failed');
  assert.equal(cancel('check', partial).status, 'failed');
  assert.equal(git(origin, 'for-each-ref', '--format=%(refname)', 'refs/heads/dickda/prev-*'), '');

  assert.equal(cancel(job.id, partial).status, 'failed');
  const retained = 'refs/heads/dickda/prev-run-101-entry';
  assert.equal(git(origin, 'rev-parse', retained), partial);
  assert.deepEqual(run('integrate'), { head: base, changed: 'false' });
  assert.equal(state().ledger.entry.status, 'rejected');
  assert.equal(state().ledger.entry.lastRejectedHead, partial);
  const [retry] = JSON.parse(lead({ action: 'dispatch', jobs: [job] }).jobs);
  assert.equal(retry.previousHead, partial);
  assert.equal(retry.previousRef, retained);
  assert.match(retry.previousFeedback, /退出码 130/);
});

test('lint rejection retains worker commits through replacement and senior retry, including a locked upstream merge', t => {
  const { work, origin, git, commit, env, run, lead, state } = workflowFixture(t);
  init(work);
  writeFileSync(join(work, '.dickda/lints/check.sh'), 'test ! -f blocked.txt\n');
  git(work, 'push', 'origin', `${commit(work, 'base lint')}:main`);
  const { reqBranch } = run('lane', { GOAL: '实现入口' });
  run('seed');
  git(work, 'fetch', 'origin', reqBranch);
  git(work, 'checkout', '--detach', 'FETCH_HEAD');

  const original = { id: 'entry', trade: 'architect', title: '入口', task: '实现入口' };
  const replacement = { ...original, id: 'entry-fix', trade: 'builder', replaces: original.id };
  const worker = (id, head) => run('worker', { JOB_ID: id, AGENT_REPLY: JSON.stringify({ session: 'engineer', head }) });
  const first = lead({ action: 'dispatch', jobs: [original], milestone: '   ' }, undefined, { CODA_THREAD_ID: '' });
  assert.equal(first.milestone, '');
  assert.equal(first.session, '');
  writeFileSync(join(work, 'blocked.txt'), 'work in progress');
  const failed = commit(work, 'partial implementation');
  assert.equal(worker(original.id, failed).status, 'rejected');
  const firstRef = 'refs/heads/dickda/prev-run-101-entry';
  assert.equal(git(origin, 'rev-parse', firstRef), failed);
  run('integrate');
  assert.equal(state().ledger.entry.lastRejectedHead, failed);
  lead({ action: 'verify' }, /被打回的编码工单：entry/);
  lead({ action: 'verify', ignoredFindings: [{ id: 'other', reason: '无关项' }] }, /被打回的编码工单：entry/);
  assert.equal(lead({ action: 'verify', ignoredFindings: [{ id: 'entry', reason: '验收范围已移除此入口' }] }).route, 'verify');

  const [retry] = JSON.parse(lead({ action: 'dispatch', jobs: [replacement] }).jobs);
  assert.equal(retry.rejections, 1);
  assert.equal(retry.previousHead, failed);
  assert.equal(retry.previousRef, firstRef);
  assert.match(retry.previousFeedback, /L2.*未通过/);
  writeFileSync(join(work, 'entry.mjs'), 'export const ready = true;\n');
  const failedAgain = commit(work, 'partial fix');
  assert.equal(worker(retry.id, failedAgain).status, 'rejected');
  run('integrate');
  assert.equal(state().ledger.entry.status, 'rejected');
  assert.equal(state().ledger[retry.id].rejections, 2);
  lead({ action: 'dispatch', jobs: [{ ...replacement, id: 'alternate' }] }, /最新打回记录在 entry-fix/);
  const [senior] = JSON.parse(lead({ action: 'dispatch', jobs: [{ ...replacement, replaces: undefined }] }).jobs);
  const secondRef = 'refs/heads/dickda/prev-run-101-entry-fix';
  assert.equal(senior.tier, 'senior');
  assert.equal(senior.replaces, original.id);
  assert.equal(senior.previousHead, failedAgain);
  assert.equal(git(origin, 'rev-parse', senior.previousRef), failedAgain);

  git(work, 'checkout', 'main');
  writeFileSync(join(work, '.dickda/lints/upstream.mjs'), '// target branch rule\n');
  const upstream = commit(work, 'upstream spec');
  git(work, 'push', 'origin', 'main');
  git(work, 'fetch', 'origin', secondRef);
  git(work, 'checkout', '--detach', 'FETCH_HEAD');
  git(work, 'merge', '--no-ff', '-m', 'merge target specs', upstream);
  unlinkSync(join(work, 'blocked.txt'));
  const fixed = commit(work, 'finish retained implementation');
  assert.equal(worker(senior.id, fixed).status, 'succeeded');
  const prompt = readFileSync(join(env.RUNNER_TEMP, 'worker-entry-fix.md'), 'utf8');
  for (const text of [failedAgain, secondRef, 'git fetch', 'git show', 'git cherry-pick', upstream]) assert.ok(prompt.includes(text), text);
  assert.equal(run('integrate').head, fixed);
  assert.deepEqual(run('integrate'), { head: fixed, changed: 'true' });
  assert.equal(state().ledger[senior.id].status, 'landed');
  assert.equal(state().ledger.entry.status, 'replaced');
  assert.equal(state().ledger.entry.replacedBy, senior.id);
  assert.equal(git(origin, 'for-each-ref', '--format=%(refname)', 'refs/heads/dickda/prev-*'), '');
  assert.equal(lead({ action: 'verify' }).route, 'verify');
});

test('parallel conflict retains the rejected commit before removing the job ref and cleans it at PR or merge', t => {
  const { work, origin, git, commit, run, lead, state } = workflowFixture(t);
  const { reqBranch } = run('lane', { GOAL: '并发实现' });
  run('seed');
  for (const step of ['pr', 'merge']) {
    git(work, 'fetch', 'origin', reqBranch);
    const base = git(work, 'rev-parse', 'FETCH_HEAD');
    const jobs = ['a', 'b'].map(id => ({ id: id + '-' + step, trade: 'builder', title: id, task: '更新入口' }));
    lead({ action: 'dispatch', jobs });
    let workerHead;
    for (const job of jobs) {
      git(work, 'checkout', '--detach', base);
      writeFileSync(join(work, 'app.mjs'), `export const entry = '${job.id}';\n`);
      workerHead = commit(work, job.id);
      assert.equal(run('worker', { JOB_ID: job.id, AGENT_REPLY: JSON.stringify({ head: workerHead, session: 'engineer' }) }).status, 'succeeded');
    }
    run('integrate');
    const entry = state().ledger[jobs[1].id];
    assert.equal(entry.status, 'rejected');
    assert.match(entry.lastFeedback, /合入冲突.*app\.mjs/);
    assert.equal(entry.lastRejectedHead, workerHead);
    assert.equal(git(origin, 'rev-parse', entry.lastRejectedRef), workerHead);
    assert.equal(git(origin, 'for-each-ref', '--format=%(refname)', 'refs/heads/dickda/job-*'), '');
    run(step);
    assert.equal(git(origin, 'for-each-ref', '--format=%(refname)', 'refs/heads/dickda/prev-*'), '');
  }
});

test('remote Git retries transient fetch and push failures, stops at three attempts, and surfaces permanent errors immediately', t => {
  const fixture = workflowFixture(t);
  const { dir, work, git, commit, run } = fixture;
  const count = join(dir, 'git-attempts');
  writeFileSync(join(dir, 'bin/git'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === process.env.FAIL_OP) {
  const file = process.env.FIXTURE_DIR + '/git-attempts';
  const attempt = Number(fs.readFileSync(file, 'utf8')) + 1;
  fs.writeFileSync(file, String(attempt));
  if (attempt <= Number(process.env.FAIL_TIMES)) { console.error(process.env.ERROR_TEXT); process.exit(1); }
}
const path = require('node:path');
const env = { ...process.env, PATH: process.env.PATH.split(path.delimiter).filter(dir => dir !== path.dirname(process.argv[1])).join(path.delimiter) };
const done = require('node:child_process').spawnSync('git', args, { stdio: 'inherit', env });
process.exit(done.status);
`, { mode: 0o755 });
  const verify = stepRunner(fixture, verifyScript);
  const refine = stepRunner(fixture, refineScript);
  function attempt(runner, step, op, times, message, expectedError) {
    writeFileSync(count, '0');
    runner(step, { GOAL: '网络重试', BRANCH: 'main', FAIL_OP: op, FAIL_TIMES: String(times), ERROR_TEXT: message }, expectedError);
    return Number(readFileSync(count, 'utf8'));
  }
  assert.equal(attempt(run, 'lane', 'fetch', 9, 'fatal: early EOF', /early EOF/), 3);
  assert.equal(attempt(run, 'lane', 'push', 9, 'fatal: permission denied', /permission denied/), 1);
  assert.equal(attempt(run, 'lane', 'fetch', 2, 'OpenSSL SSL_connect: SSL_ERROR_SYSCALL'), 3);
  assert.equal(attempt(run, 'seed', 'push', 1, 'The requested URL returned error: 503'), 2);
  assert.equal(attempt(verify, 'agent-plan', 'fetch', 1, 'fatal: early EOF'), 2);
  init(work);
  writeFileSync(join(work, '.dickda/tasks/logs/network.md'), 'investigation');
  remember(work);
  git(work, 'push', 'origin', `${commit(work, 'seed batch')}:main`);
  assert.equal(attempt(refine, 'collect', 'fetch', 9, 'fatal: early EOF', /early EOF/), 3);
  assert.equal(attempt(refine, 'collect', 'push', 1, 'Connection reset by peer'), 2);
});

test('full dickda lifecycle persists investigation archive onto delivery branch across ephemeral step worktrees', t => {
  const { dir, origin, env, git, ghCallsFile, run: runIsolatedStep } = workflowFixture(t);

  const fakeCodaAgent = join(dir, 'bin/coda-agent');
  writeFileSync(fakeCodaAgent, `#!${process.execPath}
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const args = process.argv.slice(2);
const promptFile = args[args.indexOf('--prompt-file') + 1];
const prompt = fs.readFileSync(promptFile, 'utf8');
const git = (...a) => execFileSync('git', a, { encoding: 'utf8' }).trim();

if (prompt.includes('思考者（Thinker）')) {
  fs.writeFileSync('.dickda/tasks/PLAN_5L.md', ${JSON.stringify(blueprint)});
  git('add', '.dickda/tasks/PLAN_5L.md');
  git('commit', '-m', 'docs(dickda): add 5-layer blueprint');
  console.log(JSON.stringify({ session: 'think-1', branch: 'b', head: git('rev-parse', 'HEAD'), answer: 'Blueprint ready' }));
} else if (prompt.includes('主控决策上下文')) {
  const state = JSON.parse(fs.readFileSync(process.env.CODA_ARTIFACTS + '/develop.json', 'utf8'));
  const action = Object.keys(state.ledger || {}).length === 0
    ? { action: 'dispatch', milestone: 'Dispatch wave 1', jobs: [{ id: 'impl-1', trade: 'builder', title: 'Add feature', task: 'Implement feature.mjs' }] }
    : { action: 'verify', report: '做了什么\\n- 完成五层特性实现\\n需要你知道：无', ignoredFindings: [{ id: '#1', reason: '非阻塞样式建议' }] };
  console.log(JSON.stringify({ session: 'lead-1', branch: 'b', head: git('rev-parse', 'HEAD'), answer: '\`\`\`json\\n' + JSON.stringify(action) + '\\n\`\`\`' }));
} else {
  fs.writeFileSync('feature.mjs', 'export const feature = true;\\n');
  // Exercise delivery with a job log as the only investigation file.
  fs.rmSync('.dickda/tasks/logs/investigate.md');
  fs.writeFileSync('.dickda/tasks/logs/impl-1.md', '# Investigation Log\\nConfirmed proposal A.\\n');
  git('add', 'feature.mjs', '.dickda/tasks/logs');
  git('commit', '-m', 'feat: implement feature');
  console.log(JSON.stringify({ session: 'worker-1', branch: 'b', head: git('rev-parse', 'HEAD'), answer: '交付说明\\n1. 已完成\\n2. node --test 通过' }));
}
`);
  chmodSync(fakeCodaAgent, 0o755);

  const lane = runIsolatedStep('lane', { TITLE: 'Demo Feature', GOAL: 'Implement demo feature cleanly' });
  assert.equal(lane.needBrief, 'false');
  runIsolatedStep('seed');
  runIsolatedStep('think');

  const wave1 = runIsolatedStep('lead-plan');
  assert.equal(wave1.route, 'dispatch');
  assert.equal(wave1.session, 'interactor-session');
  assert.equal(wave1.milestone, 'Dispatch wave 1');
  runIsolatedStep('worker', { JOB_ID: 'impl-1' });
  const integrated = runIsolatedStep('integrate');
  assert.equal(integrated.changed, 'true');

  const wave2 = runIsolatedStep('lead-plan');
  assert.equal(wave2.route, 'verify');
  const continuation = readFileSync(join(env.RUNNER_TEMP, 'lead-2.md'), 'utf8');
  assert.ok(continuation.startsWith('## 续跑代码视图'));
  assert.ok(continuation.includes(`git fetch https://github.com/fixture/dickda-demo.git ${lane.reqBranch} && git checkout --detach ${integrated.head}`));
  assert.match(continuation, /新增提交：\n[0-9a-f]+ feat: implement feature/);
  assert.match(continuation, /git diff --stat：[\s\S]*?feature\.mjs\s+\|/);
  assert.equal(JSON.parse(readFileSync(join(env.CODA_ARTIFACTS, 'develop.json'))).lastLeadHead, integrated.head);

  // Archive delivery runs in a fresh step clone, commits & pushes .dickda/learning/<timestamp> onto reqBranch!
  const archivedStep = runIsolatedStep('archive-delivery');
  assert.equal(archivedStep.needChecks, 'true');
  runIsolatedStep('checks-passed', { RUNS: JSON.stringify([{ workflow: 'check', state: 'succeeded', runId: 'chk-1' }]) });

  const prep = runIsolatedStep('prepare-verify');
  assert.equal(prep.head, archivedStep.head);
  assert.match(prep.evidence, /chk-1/);

  // Empty REVIEW={} MUST route to retry, NOT pr!
  const badReview = runIsolatedStep('verified', { VERIFY_COMMIT: prep.head, VERIFY_PASSED: 'true', VERIFY_REPORT: 'ok', REVIEW: '{}' });
  assert.equal(badReview.route, 'retry');

  // Matching head + APPROVE routes to pr
  const goodReview = runIsolatedStep('verified', {
    VERIFY_COMMIT: prep.head,
    VERIFY_PASSED: 'true',
    VERIFY_REPORT: '双轨全绿',
    REVIEW: JSON.stringify({ head: prep.head, decision: 'APPROVE', line: 'LGTM', report: 'Clean' }),
  });
  assert.equal(goodReview.route, 'pr');

  const pr = runIsolatedStep('pr', { DEVICES: 'false' });
  assert.equal(pr.url, 'https://github.com/fixture/dickda-demo/pull/7');
  runIsolatedStep('approval-check');
  const merged = runIsolatedStep('merge');
  assert.equal(merged.route, 'merged');

  // Verify the pushed remote reqBranch commit actually contains the persisted archive and reset investigate.md!
  const inspectDir = join(dir, 'inspect-remote');
  git(dir, 'clone', '-q', '-b', lane.reqBranch, origin, inspectDir);
  assert.equal(backups(inspectDir, 5).length, 1, 'archive must be persisted in Git on the delivered commit');
  assert.equal(readFileSync(join(inspectDir, '.dickda/tasks/logs/investigate.md'), 'utf8'), INVESTIGATE_MARKER);
  assert.ok(!existsSync(join(inspectDir, '.dickda/tasks/logs/impl-1.md')));
  assert.ok(buildRefineContext(inspectDir).files.some(f => f.body.includes('Confirmed proposal A.')));

  const ghCalls = readFileSync(ghCallsFile, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.ok(ghCalls.filter(c => c.args[0] === 'pr').every(c => c.thread === null));
});

test('dickda-refine chains refactor commits across ephemeral step worktrees, persists to remote PR, and preserves archive on failure', t => {
  const { dir, work, origin, env, git, commit } = createGitRepo(t);
  init(work);
  writeFileSync(join(work, '.dickda/learning/Learning_General.md'), '# !!!LEARNING!!!\n- 旧口头规则：人工检查导出常量 [3]\n');
  writeFileSync(join(work, '.dickda/tasks/logs/investigate.md'), '# Log\nRepeated missing export lint.\n');
  const archived = remember(work, new Date('2026-11-24T12:00:00Z'));
  assert.equal(archived.archived, true);
  commit(work, 'seed archive for refine');
  git(work, 'push', '-q', origin, 'main');

  // 1) Failure in refactor worker MUST NOT consume archive
  const failClone = join(dir, 'refine-fail-check');
  git(dir, 'clone', '-q', origin, failClone);
  git(failClone, 'config', 'user.name', 'Tester');
  git(failClone, 'config', 'user.email', 'tester@example.com');
  const startSha = git(failClone, 'rev-parse', 'HEAD');
  const failDiag = normalizeDiagnosis({
    needsRefactor: true,
    layers: ['L2'],
    summary: 'Add lint',
    actions: [{ layer: 'L2', trade: 'architect', title: 'Add lint', task: 'write lint' }],
  });
  assert.throws(() => executeRefinePlan(failClone, {
    startHead: startSha,
    refineBranch: 'dickda/refine-fail',
    archive: archived.path,
    choice: 'refactor',
    diagnosis: failDiag,
    runner: () => ({ status: 0, stdout: JSON.stringify({ session: 's1', head: startSha, answer: 'forgot to commit' }) }),
  }), /未产生新提交/);
  git(failClone, 'checkout', '-f', 'main');
  assert.equal(backups(failClone, 5).length, 1, 'archive on main remains intact when refactor worker fails');

  // 1b) Diverged sibling commits across two refactor actions MUST fail and preserve archive instead of dropping action 1's commit
  git(failClone, 'checkout', '-b', 'sibling-1', startSha);
  writeFileSync(join(failClone, 'first-refactor.mjs'), 'export const first = 1;\n');
  const siblingHead1 = commit(failClone, 'refactor 1');
  git(failClone, 'checkout', '-b', 'sibling-2', startSha);
  writeFileSync(join(failClone, 'second-refactor.mjs'), 'export const second = 2;\n');
  const siblingHead2 = commit(failClone, 'diverged sibling refactor 2');
  git(failClone, 'checkout', '-f', 'main');

  let callIdx = 0;
  const twoActionDiag = normalizeDiagnosis({
    needsRefactor: true,
    layers: ['L1', 'L2'],
    summary: 'Two refactors',
    actions: [
      { layer: 'L1', trade: 'builder', title: 'First refactor', task: 'step 1' },
      { layer: 'L2', trade: 'architect', title: 'Second refactor', task: 'step 2' },
    ],
  });
  assert.throws(() => executeRefinePlan(failClone, {
    startHead: startSha,
    refineBranch: 'dickda/refine-diverged',
    archive: archived.path,
    choice: 'refactor',
    diagnosis: twoActionDiag,
    runner: () => ({
      status: 0,
      stdout: JSON.stringify({ session: `sib-${++callIdx}`, head: callIdx === 1 ? siblingHead1 : siblingHead2, answer: 'done' }),
    }),
  }), /严格后代/);
  git(failClone, 'checkout', '-f', 'main');
  assert.equal(backups(failClone, 5).length, 1, 'archive remains unconsumed when second worker returns a diverged commit');

  // 2) Full multi-step ephemeral BPMN refine flow chains two engineer commits + L4 prose cleanup + archive removal and pushes to remote PR
  const fakeGh = join(dir, 'bin/gh');
  writeFileSync(fakeGh, `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] === 'repo') console.log(JSON.stringify({ nameWithOwner: 'fixture/dickda-demo', defaultBranchRef: { name: 'main' } }));
else if (args[0] === 'pr' && args[1] === 'list') console.log('[]');
else if (args[0] === 'pr' && args[1] === 'create') console.log('https://github.com/fixture/dickda-demo/pull/9');
`);
  chmodSync(fakeGh, 0o755);

  const fakeAgent = join(dir, 'bin/coda-agent');
  writeFileSync(fakeAgent, `#!${process.execPath}
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const args = process.argv.slice(2);
const commitSha = args[args.indexOf('--commit') + 1];
const prompt = fs.readFileSync(args[args.indexOf('--prompt-file') + 1], 'utf8');
const git = (...a) => execFileSync('git', a, { encoding: 'utf8' }).trim();
fs.appendFileSync(process.env.FIXTURE_DIR + '/refine-agents.jsonl', JSON.stringify(args) + '\\n');
git('checkout', '--detach', '--force', commitSha);

if (prompt.includes('Refine 归档复盘输入')) {
  const diag = {
    needsRefactor: true,
    layers: ['L1', 'L2', 'L4'],
    summary: 'Add helper and L2 lint, remove obsolete prose',
    actions: [
      { layer: 'L1', trade: 'builder', title: 'Add helper', task: 'create helper.mjs' },
      { layer: 'L2', trade: 'architect', difficulty: 'hard', title: 'Add lint requiring helper', task: 'verify helper.mjs exists' },
    ],
    obsoleteProse: ['旧口头规则：人工检查导出常量'],
    learningUpdates: ['导出常量已由 .dickda/lints/require-helper.mjs 自动守护'],
  };
  console.log(JSON.stringify({ session: 'diag-1', head: commitSha, answer: '\`\`\`json\\n' + JSON.stringify(diag) + '\\n\`\`\`' }));
} else if (prompt.includes('Add helper')) {
  fs.writeFileSync('helper.mjs', 'export const helper = 1;\\n');
  git('add', 'helper.mjs');
  git('commit', '-m', 'refactor(L1): add helper.mjs');
  console.log(JSON.stringify({ session: 'r1', head: git('rev-parse', 'HEAD'), answer: 'done 1' }));
} else {
  // Step 2 MUST see helper.mjs created by Step 1!
  if (!fs.existsSync('helper.mjs')) process.exit(2);
  fs.mkdirSync('.dickda/lints', { recursive: true });
  fs.writeFileSync('.dickda/lints/require-helper.mjs', 'import { existsSync } from "node:fs"; import { join } from "node:path"; if (!existsSync(join(process.env.DICKDA_ROOT, "helper.mjs"))) process.exit(1);\\n');
  git('add', '.dickda/lints/require-helper.mjs');
  git('commit', '-m', 'feat(L2): add require-helper lint');
  console.log(JSON.stringify({ session: 'r2', head: git('rev-parse', 'HEAD'), answer: 'done 2' }));
}
`);
  chmodSync(fakeAgent, 0o755);

  const refineArtifacts = join(dir, 'refine-artifacts');
  mkdirSync(refineArtifacts, { recursive: true });
  const runRefineStep = stepRunner({ dir, origin, git, env: { ...env, CODA_ARTIFACTS: refineArtifacts, GITHUB_RUN_ID: 'refine-202' } }, refineScript);

  const collected = runRefineStep('collect');
  assert.equal(collected.hasArchive, 'true');
  assert.equal(collected.archive, archived.path);

  const diagnosed = runRefineStep('diagnose');
  assert.equal(diagnosed.needsRefactor, 'true');

  runRefineStep('decide', { DECISION: JSON.stringify({ choice: 'refactor', note: 'Proceed with L1+L2' }) });
  const executed = runRefineStep('execute', { BUILDER: '{"agent":"custom-builder"}', ARCHITECT_SENIOR: '{"agent":"senior-architect"}' });
  assert.ok(executed.head);

  const agents = readFileSync(join(dir, 'refine-agents.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(agents.slice(1).map(args => args[args.indexOf('--agent') + 1]), ['custom-builder', 'senior-architect']);
  const review = runRefineStep('prepare-review', { VERIFIER_SENIOR: '{"agent":"senior-reviewer"}' });
  assert.equal(review.tier, 'senior');
  runRefineStep('reviewed', { REVIEW: JSON.stringify({ head: review.head, decision: 'APPROVE' }) });
  const delivered = runRefineStep('deliver');
  assert.equal(delivered.pr, 'https://github.com/fixture/dickda-demo/pull/9');
  assert.ok(delivered.summary.includes(archived.path));
  assert.match(delivered.summary, /senior-reviewer/);

  // Verify the pushed remote refine branch has helper.mjs (L1), require-helper.mjs (L2), slimmed Learning_General.md (L4), and consumed archive!
  const verifyRemoteDir = join(dir, 'verify-refine-remote');
  git(dir, 'clone', '-q', '-b', 'dickda/refine-refine-202', origin, verifyRemoteDir);
  assert.ok(existsSync(join(verifyRemoteDir, 'helper.mjs')));
  assert.ok(existsSync(join(verifyRemoteDir, '.dickda/lints/require-helper.mjs')));
  assert.equal(backups(verifyRemoteDir, 5).length, 0);
  const slimmed = readFileSync(join(verifyRemoteDir, '.dickda/learning/Learning_General.md'), 'utf8');
  assert.doesNotMatch(slimmed, /旧口头规则/);
  assert.match(slimmed, /require-helper\.mjs/);
});

function refineFixture(t, broken = false) {
  const fixture = workflowFixture(t, refineScript);
  const { work, git, commit, env, run, state } = fixture;
  env.CODA_PLUGIN_SETTINGS = JSON.stringify({ 'dickda.mergeMethod': 'squash' });
  init(work);
  writeFileSync(join(work, '.dickda/lints/healthy.sh'), 'test ! -e broken\n');
  if (broken) writeFileSync(join(work, 'broken'), 'failed check\n');
  writeFileSync(join(work, '.dickda/tasks/logs/worker.md'), '入口调查\n');
  const { path: archive } = remember(work);
  const original = commit(work, 'seed investigation batch');
  git(work, 'push', 'origin', 'main');
  run('collect');
  const diagnosis = { layers: ['L4'], summary: '记录入口约定', learningUpdates: ['入口须可重试'] };
  run('diagnose', { THINKER: '{"agent":"custom-thinker"}', AGENT_REPLY: JSON.stringify({ answer: '```json\n' + JSON.stringify(diagnosis) + '\n```' }) });
  assert.ok(JSON.parse(readFileSync(join(fixture.dir, 'agent-args.json'))).includes('custom-thinker'));
  run('decide', { DECISION: '{"choice":"prose"}' });
  const branch = state().refineBranch;
  function checkoutCandidate() {
    git(work, 'fetch', 'origin', branch);
    git(work, 'checkout', '--detach', 'FETCH_HEAD');
  }
  return { ...fixture, archive, original, branch, checkoutCandidate };
}

test('refine routes hook failures, incomplete reviews, human decisions and conflicts before merging', () => {
  const { xml, routes, card } = workflowGraph('dickda-refine');
  for (const input of ['thinker', 'architect', 'architectSenior', 'builder', 'builderSenior', 'verifier', 'verifierSenior']) {
    assert.match(xml, new RegExp(`<coda:input name="${input}"[^>]*type="agent"`));
    assert.ok(xml.includes(`value="=inputs.${input}"`));
  }
  for (const step of ['execute', 'repair', 'checks', 'review-commit', 'premerge', 'github-checks']) {
    assert.match(xml, new RegExp(`attachedToRef="${step}">\\s*<errorEventDefinition`));
  }
  for (const step of ['execute-error', 'checks-failed', 'premerge-failed', 'gh-failed', 'continue-repair']) {
    assert.deepEqual(routes(step), { repair: 'always' });
  }
  assert.deepEqual(routes('repair'), { checks: 'always' });
  assert.match(xml, /name="commit" value="=if repair.head = null then execute.head else repair.head"/);
  assert.deepEqual(routes('help-choice'), { 'continue-repair': '=repair-help.chose.continue', 'record-stop': 'always' });
  assert.deepEqual(routes('checks'), { 'prepare-review': 'always' });
  // An agent parameter takes a FEEL context. Script outputs alone can only supply text.
  for (const [name, step] of [['dickda-refine', 'prepare-review'], ['dickda', 'prepare-verify']]) {
    const binding = workflowGraph(name).xml.match(/<coda:param name="reviewer" value='([^']+)'/)[1];
    assert.ok(binding.includes(`${step}.tier = "senior"`));
    assert.ok(binding.includes('then inputs.verifierSenior else vars.dickda.verifierSenior'));
    assert.ok(binding.includes('then inputs.verifier else vars.dickda.verifierStandard'));
  }
  assert.deepEqual(routes('review-error'), { 'review-retry': 'always' });
  assert.deepEqual(routes('review-gate'), { deliver: '=reviewed.route = "pr"', adjudicate: '=reviewed.route = "changes"', 'review-retry': 'always' });
  assert.deepEqual(routes('retry-choice'), { 'review-commit': '=review-retry.chose.retry', 'record-stop': 'always' });
  assert.match(card('adjudicate'), /id="kept"[^>]*note="required"/);
  assert.deepEqual(routes('review-choice'), { deliver: '=review-decision.route = "kept"', repair: 'always' });
  assert.deepEqual(routes('deliver'), { premerge: 'always' });
  assert.deepEqual(routes('premerge'), { 'github-checks': 'always' });
  assert.deepEqual(routes('gh-gate'), { 'gh-failed': '=not(github-checks.passed)', joiners: 'always' });
  assert.deepEqual(routes('joiners'), { 'approval-check': 'always' });
  assert.deepEqual(routes('approval-check'), { approve: 'always' });
  assert.match(card('approve'), /name="批准合并五层提纯 PR" coda:assignee="user"/);
  assert.match(card('approve'), /approval-check.summary[\s\S]*optionList value="=joiners.list"/);
  assert.deepEqual(routes('approve-gate'), { 'approval-parse': '=approve.chose.merge', 'record-stop': 'always' });
  assert.deepEqual(routes('record-stop'), { stopped: 'always' });
  assert.deepEqual(routes('approval-parse'), { merge: 'always' });
  assert.deepEqual(routes('merge-gate'), { repair: '=merge.route = "conflict"', 'after-merge': 'always' });
  assert.match(xml, /id="merged-flows"[\s\S]*?name="commit" value="=merge.commit"/);
});

test('refine repairs failed execution and checks only with verified descendant commits; blocked repairs can stop or resume', t => {
  const { work, git, commit, origin, original, archive, branch, run, state, checkoutCandidate } = refineFixture(t, true);
  const tip = () => git(origin, 'rev-parse', branch);
  run('execute', {}, /L2\/L3 验证未通过/);
  assert.equal(tip(), original);
  assert.match(run('repair-status').reason, /healthy.sh/);
  const reply = head => ({ AGENT_REPLY: JSON.stringify({ head }) });
  run('repair', reply(original), /未产生新提交/);
  checkoutCandidate();
  writeFileSync(join(work, 'attempt'), 'still broken');
  run('repair', reply(commit(work, 'repair still fails lint')), /L2\/L3 验证未通过/);
  assert.equal(tip(), original);
  run('repair', reply(original), /未产生新提交/);
  run('repair', {}, /自动修复已达 3 次/);
  run('continue-repair', { NOTE: '移除 broken 并保留入口约定' });
  assert.match(state().failure, /移除 broken/);
  checkoutCandidate();
  unlinkSync(join(work, 'broken'));
  const fixed = run('repair', reply(commit(work, 'fix lint')));
  assert.equal(tip(), fixed.head);
  assert.equal(git(origin, 'ls-tree', fixed.head, '--', archive), '');
  assert.match(git(origin, 'show', `${fixed.head}:.dickda/learning/Learning_General.md`), /入口须可重试/);
  assert.ok(git(origin, 'ls-tree', 'main', '--', archive));
  for (const step of ['项目检查', '合并前检查', 'GitHub 检查']) {
    run('failed', { STEP: step, LINES: 'smoke failed' });
    assert.ok(state().failure.includes(step));
    assert.match(state().failure, /smoke failed/);
  }
  checkoutCandidate();
  writeFileSync(join(work, 'smoke.mjs'), 'export const healthy = true;\n');
  const smokeFix = commit(work, 'fix smoke check');
  assert.equal(run('repair', reply(smokeFix)).head, smokeFix);
  assert.equal(run('prepare-review', { RUNS: '[]' }).head, smokeFix);
  run('reviewed', { REVIEW: JSON.stringify({ head: smokeFix, decision: 'APPROVE' }) });
  const pr = run('deliver').pr;
  const stopped = run('stopped', { REASON: '保留归档待下次处理' });
  assert.equal(stopped.branch, branch);
  assert.equal(stopped.pr, pr);
  assert.equal(stopped.reason, '保留归档待下次处理');
  assert.equal(tip(), smokeFix);
  assert.equal(git(origin, 'rev-parse', 'main'), original);
});

test('refine binds review, kept rationale and user approval to the head, revalidates a conflict resolution and consumes the archive on main', t => {
  const { work, git, commit, origin, archive, original, run, state, branch, checkoutCandidate, artifacts, ghCallsFile } = refineFixture(t);
  const first = run('execute').head;
  const prep = run('prepare-review', { VERIFIER: '{"agent":"alternate-reviewer"}', RUNS: '[{"workflow":"check","state":"succeeded","runId":"check-1"}]' });
  assert.equal(prep.base, original);
  assert.equal(prep.head, first);
  assert.equal(prep.previous, '');
  assert.equal(prep.tier, 'standard');
  assert.equal(state().reviewer, 'alternate-reviewer');
  assert.match(prep.evidence, /check-1/);
  for (const review of ['', '{broken', '{}', JSON.stringify({ head: first, decision: 'INCOMPLETE' }), JSON.stringify({ head: original, decision: 'APPROVE' })]) {
    assert.equal(run('reviewed', { REVIEW: review }).route, 'retry');
    run('deliver', {}, /独立代码审查/);
  }
  const finding = { level: 'must', kind: 'contract', title: '入口返回值', location: 'app.mjs:1', detail: '入口仍返回旧值' };
  const review = (head, decision, fields = {}, previous = '') => run('reviewed', {
    REVIEW: JSON.stringify({ head, decision, ...fields }), PREVIOUS: previous,
  });
  assert.equal(review(first, 'REQUEST_CHANGES', { findings: JSON.stringify([finding]) }).route, 'changes');
  run('deliver', {}, /REQUEST_CHANGES/);
  run('review-decision', { DECISION: '{"choice":"repair","note":"修复入口"}' });
  assert.match(state().failure, /入口仍返回旧值[\s\S]*修复入口/);
  checkoutCandidate();
  writeFileSync(join(work, 'app.mjs'), 'export const answer = () => 43;\n');
  const repaired = commit(work, 'repair entry');
  const repair = head => ({ AGENT_REPLY: JSON.stringify({ head }) });
  assert.equal(run('repair', repair(repaired)).head, repaired);
  const next = run('prepare-review');
  const previous = JSON.parse(next.previous);
  assert.deepEqual(previous, [{ ...finding, id: `${first.slice(0, 12)}-1` }]);
  assert.equal(next.base, first);
  assert.equal(next.head, repaired);
  const report = '复评要求保持旧值';
  assert.equal(review(repaired, 'REQUEST_CHANGES', {
    report, findings: '[]', resolutions: JSON.stringify([{ id: previous[0].id, status: 'upheld', reason: report }]),
  }, next.previous).route, 'changes');
  assert.deepEqual(state().openReviewFindings, previous);
  run('review-decision', { DECISION: '{"choice":"kept","note":"  "}' }, /客观依据/);
  const reason = '入口契约已改为 43，提交中的用例覆盖了新版接口。';
  run('review-decision', { DECISION: JSON.stringify({ choice: 'kept', note: reason }) });
  const pr = run('deliver');
  assert.equal(pr.summary, readFileSync(join(artifacts, 'refine-pr.md'), 'utf8'));
  assert.equal(run('approval-check').summary, pr.summary);
  for (const item of [archive, 'L4', repaired, 'L2 Lints', report, 'REQUEST_CHANGES', reason]) assert.ok(pr.summary.includes(item), item);
  for (const [env, error] of [
    [{ PR_VIEW: '{"state":"CLOSED"}' }, /PR 已关闭/],
    [{ PR_VIEW: JSON.stringify({ headRefOid: original }) }, /提交已改变/],
    [{ PR_VIEW: '{"baseRefName":"other"}' }, /默认分支/],
    [{ DEFAULT_BRANCH: 'trunk' }, /默认分支/],
  ]) {
    run('approval-check', env, error);
    run('merge', env, error);
  }
  assert.equal(git(origin, 'rev-parse', 'main'), original);
  assert.equal(git(origin, 'rev-parse', branch), repaired);

  git(work, 'checkout', 'main');
  writeFileSync(join(work, 'app.mjs'), 'export const answer = () => 44;\n');
  const upstream = commit(work, 'upstream change to same line');
  git(work, 'push', 'origin', 'main');
  assert.equal(run('merge').route, 'conflict');
  assert.ok(git(origin, 'ls-tree', 'main', '--', archive));
  checkoutCandidate();
  writeFileSync(join(work, 'unrelated'), 'does not resolve the conflict');
  run('repair', repair(commit(work, 'unsynced descendant')), /尚未合入默认分支/);
  assert.equal(git(origin, 'rev-parse', branch), repaired);
  run('continue-repair', { NOTE: '合入最新 main 并保留新版契约' });
  checkoutCandidate();
  assert.throws(() => git(work, 'merge', '--no-commit', upstream), /Command failed/);
  assert.equal(git(work, 'diff', '--name-only', '--diff-filter=U'), 'app.mjs');
  writeFileSync(join(work, 'app.mjs'), 'export const answer = () => 45;\n');
  git(work, 'add', 'app.mjs');
  git(work, 'commit', '-m', 'resolve entry conflict');
  const resolved = git(work, 'rev-parse', 'HEAD');
  assert.equal(run('repair', repair(resolved)).head, resolved);
  run('deliver', {}, /不一致/);
  const last = run('prepare-review', { RUNS: '[{"workflow":"check","state":"succeeded","runId":"check-3"}]' });
  assert.equal(last.head, resolved);
  assert.equal(review(resolved, 'APPROVE', { resolutions: JSON.stringify([{ id: previous[0].id, status: 'resolved' }]) }, last.previous).route, 'pr');
  const updated = run('deliver');
  assert.equal(updated.pr, pr.pr);
  assert.match(updated.summary, /check-3/);
  assert.match(updated.summary, /独立审查 · APPROVE/);
  assert.ok(updated.summary.includes(`${repaired}（REQUEST_CHANGES）：${reason}`));
  assert.equal(run('approval-check').summary, updated.summary);
  const merged = run('merge');
  assert.deepEqual(merged, { route: 'merged', commit: git(origin, 'rev-parse', 'main') });
  assert.notEqual(merged.commit, resolved);
  assert.deepEqual(run('merge'), merged);
  assert.equal(git(origin, 'ls-tree', 'main', '--', archive), '');
  assert.equal(git(origin, 'show', 'main:app.mjs'), 'export const answer = () => 45;');
  assert.equal(git(origin, 'branch', '--list', branch), '');
  const calls = readFileSync(ghCallsFile, 'utf8').trim().split('\n').map(JSON.parse).filter(call => call.args[0] === 'pr');
  assert.ok(calls.every(call => call.thread === null));
  assert.equal(calls.filter(call => call.args[1] === 'create').length, 1);
  assert.ok(calls.some(call => call.args[1] === 'edit' && call.args.includes('--body-file')));
  assert.deepEqual(calls.filter(call => call.args[1] === 'merge').map(call => call.args.slice(-4)),
    [repaired, resolved].map(head => ['--squash', '--match-head-commit', head, '--delete-branch']));
});

test('custom prompts and interactive HTML dashboard work cohesively', t => {
  const { work, env, dir } = createGitRepo(t);
  init(work);

  assert.deepEqual(builtinPrompts().map(p => p.id), ['general', 'cpp']);
  const tpl = promptTemplate('team-arch');
  putPrompt(work, tpl);
  enablePrompt(work, 'team-arch', true);
  assert.ok(prompts(work).find(p => p.id === 'team-arch')?.enabled);
  assert.match(renderPrompt(builtinPrompts()[0], 'correctness'), /crash early/i);

  const htmlPath = join(dir, 'console.html');
  const cliOut = execFileSync(process.execPath, [cliScript, 'dashboard', '--root', work, '--output', htmlPath], { env, encoding: 'utf8' });
  const parsedCli = JSON.parse(cliOut);
  assert.equal(parsedCli.path, htmlPath);
  const html = readFileSync(htmlPath, 'utf8');
  assert.match(html, /五层工程控制台/);
  assert.match(html, /window\.coda\.submit/);
  assert.ok(Buffer.byteLength(html, 'utf8') < 20 * 1024 * 1024);
});
