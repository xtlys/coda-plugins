import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { CONSUMED_FILE, assetsByKind, backups, checkSpecLock, consumeBackup, hasAgentVerifiers, layerHealth, remember, runLints } from '../../plugins/dickda/scripts/assets.mjs';
import { buildDashboardData } from '../../plugins/dickda/scripts/dashboard.mjs';
import { enrichDispatchBatch, evaluateVerificationGate, evaluateVerifierAnswer, integrateWorkerResults } from '../../plugins/dickda/scripts/develop.mjs';
import { builtinPrompts, enablePrompt, promptTemplate, prompts, putPrompt, renderPrompt } from '../../plugins/dickda/scripts/prompts.mjs';
import { applyProseRefinements, buildRefineContext, executeRefinePlan, normalizeDiagnosis } from '../../plugins/dickda/scripts/refine.mjs';
import { ROLES, DEFAULT_SETTINGS, agentArgs, effectiveSettings, loadSettings, resolveEngineer, rolePrompt } from '../../plugins/dickda/scripts/roles.mjs';
import { INVESTIGATE_MARKER, hash, init, inside, projectGroup, runtime } from '../../plugins/dickda/scripts/store.mjs';
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

const blueprint = ['架构边界', 'Lint 规则', '验证用例', '并发Work Order', 'Human Review']
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
  const seedFast = () => {
    const seed = run('seed');
    Object.assign(fixture.env, { FAST: 'true', SEED_HEAD: seed.head });
    return seed;
  };
  const lead = (decision, expectedError, extra = {}) => run('lead-plan', {
    AGENT_REPLY: JSON.stringify({ session: 'lead', answer: '```json\n' + JSON.stringify(decision) + '\n```' }),
    ...extra,
  }, expectedError);
  return { ...fixture, ghCallsFile, run, seedFast, lead, state };
}

test('dickda declares its Coda engine and uses supported contributions', () => {
  const { name, displayName, engines, contributes } = JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8'));
  assert.equal(name, 'dickda');
  assert.equal(displayName, 'dickda');
  assert.equal(engines.coda, 1);
  assert.ok([...contributes.instructions].length <= 200);
  assert.ok(contributes.instructions.startsWith('采用 dickda Mode 时，先读 `dickda role show interactor`'));
  for (const key of ['endpoints', 'groups', 'events', 'resources', 'panels', 'extensionPoints', 'extensions']) {
    assert.ok(!Object.hasOwn(contributes, key), `retired contribution: ${key}`);
  }
  assert.deepEqual(contributes.skills, ['skills/dickda']);
  assert.equal(contributes.commands[0].name, 'dickda');
});

test('three roles and four trades default to exact requested models and escalate to senior on difficulty or rejections', () => {
  const settings = loadSettings('{}');
  assert.deepEqual(settings.interactor, { agent: 'antigravity', mode: 'full', model: 'gemini-4-neon', effort: 'xhigh' });
  assert.deepEqual(settings.thinker, { agent: 'antigravity', mode: 'full', model: 'gemini-4-carbon', effort: 'high' });
  assert.deepEqual(settings.lead, { agent: 'antigravity', mode: 'full', model: 'gemini-4-neon', effort: 'xhigh' });

  const archStd = resolveEngineer('architect', { difficulty: 'normal', rejections: 0 }, settings);
  assert.equal(archStd.tier, 'standard');
  assert.equal(archStd.escalated, false);
  assert.deepEqual(archStd.agent, { agent: 'antigravity', mode: 'full', model: 'claude-opus-5-5', effort: 'high' });

  const archHard = resolveEngineer('architect', { difficulty: 'hard', rejections: 0 }, settings);
  assert.equal(archHard.tier, 'senior');
  assert.equal(archHard.escalated, true);
  assert.deepEqual(archHard.agent, { agent: 'antigravity', mode: 'full', model: 'gemini-4-carbon', effort: 'high' });

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
    assert.ok(prompt.length > 80 && prompt.startsWith('# Role:'), `role prompt missing for ${role}`);
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

test('refine prepare and develop lane share a project lock across clones and pre-init checkouts', t => {
  const { dir, work, env, git, commit } = workflowFixture(t);
  git(work, 'branch', 'pre-init');
  const { projectId } = init(work);
  commit(work, 'initialize on the original machine');
  git(work, 'push', 'origin', 'main', 'pre-init');

  const clone = join(dir, 'clone');
  const remote = env.GIT_CONFIG_VALUE_0;
  git(dir, 'clone', '-q', remote, clone);
  git(clone, 'remote', 'set-url', 'origin', 'git@GitHub.com:Fixture/Dickda-Demo.git');
  const group = `dickda:${hash('github.com/fixture/dickda-demo')}`;
  assert.equal(projectGroup(work, remote), group);
  assert.equal(projectGroup(clone, 'ssh://git@GitHub.com:22/Fixture/Dickda-Demo.git/'), group);
  assert.equal(JSON.parse(readFileSync(join(clone, '.dickda/project.json'))).projectId, projectId);
  assert.notEqual(hash(realpathSync(join(clone, '.git'))), projectId);
  for (const branch of ['main', 'pre-init']) {
    git(clone, 'checkout', '-q', branch);
    assert.equal(existsSync(join(clone, '.dickda/project.json')), branch === 'main');
    assert.equal(projectGroup(clone), group);
    const artifacts = join(dir, branch);
    mkdirSync(artifacts);
    for (const [script, action] of [[refineScript, 'prepare'], [developScript, 'lane']]) {
      writeFileSync(env.GITHUB_OUTPUT, '');
      execFileSync(process.execPath, [script, action], { cwd: clone, env: { ...env, CODA_ARTIFACTS: artifacts, BRANCH: branch } });
      assert.equal(parseOutputs(env.GITHUB_OUTPUT).group, group);
    }
  }

  git(clone, 'remote', 'remove', 'origin');
  const linked = join(dir, 'linked');
  git(clone, 'worktree', 'add', '-q', '--detach', linked, 'main');
  const localGroup = `dickda:${hash(realpathSync(join(clone, '.git')))}`;
  assert.equal(projectGroup(clone), localGroup);
  assert.equal(projectGroup(linked), localGroup);
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
const checked = require('node:child_process').execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
console.log(JSON.stringify({ session: 'sol-1', answer: '\`\`\`json\\n' + JSON.stringify({ passed: checked === commitSha, summary: 'checked ' + commitSha, evidence: ['git rev-parse HEAD: ' + checked], findings: [] }) + '\\n\`\`\`' }));
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
  assert.deepEqual(JSON.parse(sumOut.evidence), ['git rev-parse HEAD: ' + goodDeliveryHead]);
  assert.equal(checkoutTargetCommit(stepCodeWork, { commit: goodDeliveryHead }), goodDeliveryHead);

  writeFileSync(join(env.CODA_ARTIFACTS, 'agent-verify.json'), JSON.stringify({ passed: true, commit: mainHead }));
  const mismatched = spawnSync(process.execPath, [verifyScript, 'summary'], { cwd: stepCodeWork, env, encoding: 'utf8' });
  assert.equal(mismatched.status, 1);
  assert.ok(mismatched.stderr.includes(`Code Track ${goodDeliveryHead} vs Agent/UI Track ${mainHead}`));
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
console.log(JSON.stringify({ answer: '\`\`\`json\\n{"passed":true,"summary":"登录后显示首页","evidence":[{"path":"login.png"}]}\\n\`\`\`' }));
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

test('Agent/UI specifications require a summary and substantive evidence for a passing verdict', t => {
  const { work } = createGitRepo(t);
  init(work);
  writeFileSync(join(work, '.dickda/verifiers/login.md'), '登录后应显示首页。');
  const verify = verdict => runAgentVerifiers(work, {
    runner: () => ({ status: 0, stdout: JSON.stringify({ answer: '```json\n' + JSON.stringify(verdict) + '\n```' }) }),
  });
  const pass = { passed: true, summary: '登录后显示首页' };
  assert.throws(() => verify({ passed: true }), /summary/);
  assert.throws(() => verify({ ...pass, summary: ' \n', evidence: ['login.png'] }), /summary/);
  for (const evidence of [undefined, 'login.png', [], [' \t'], [null, {}, { path: ' ', exitCode: 0 }]]) {
    assert.throws(() => verify({ ...pass, evidence }), /evidence.*非空实证/);
  }
  for (const evidence of [['login.png'], [' ', { step: 2, path: 'login.png' }]]) {
    const result = verify({ ...pass, evidence });
    assert.equal(result.passed, true);
    assert.deepEqual(result.evidence, evidence);
  }
  assert.equal(verify({ passed: false, summary: '登录入口未显示' }).passed, false);
});

test('dispatch IDs and replacement references reserve the same case-insensitive namespace across rounds', () => {
  const job = { id: 'ui', trade: 'verifier', title: '验收入口', task: '检查登录入口' };
  const upper = { ...job, id: 'UI' };
  const ledger = { ui: { ...job, status: 'rejected' } };
  assert.throws(() => enrichDispatchBatch([job, upper]), /重复.*忽略大小写/);
  assert.throws(() => enrichDispatchBatch([upper], ledger), /UI.*历史Work Order ui.*大小写/);
  assert.throws(() => enrichDispatchBatch([{ ...job, id: 'retry', replaces: 'UI' }], ledger), /UI.*历史Work Order ui.*大小写/);
  assert.throws(() => enrichDispatchBatch([{ ...job, id: 'retry', replaces: 'ui' }, job], ledger), /重复/);
  assert.equal(enrichDispatchBatch([upper])[0].id, 'UI');
  assert.equal(enrichDispatchBatch([job], ledger)[0].id, 'ui');
});

test('verifier worker failures and missing/failed review-commit calls never silently pass', t => {
  const { work, commit } = createGitRepo(t);
  init(work);
  const baseTip = commit(work, 'base');

  // 1) Verifier worker returning passed=false or missing JSON must be rejected and counted toward senior escalation
  const failedEval = evaluateVerifierAnswer('```json\n{"passed": false, "summary": "按钮点击无响应", "findings": [], "resolved": ["ver-ui#1", "", "  ", null, 2]}\n```');
  assert.equal(failedEval.valid, true);
  assert.equal(failedEval.passed, false);
  assert.deepEqual(failedEval.resolved, ['ver-ui#1']);

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
  consumeBackup(work, later.path);
  consumeBackup(work, archived.path);
  assert.equal(readFileSync(join(work, CONSUMED_FILE), 'utf8'), `${archived.path}\n${later.path}\n`);
  writeFileSync(shared, 'New investigation at the same timestamp\n');
  assert.ok(remember(work, time).path > later.path);
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

test('archive readers agree with the consumption record even when consumed directories remain on disk', t => {
  const { work, env } = createGitRepo(t);
  init(work);
  const dirs = ['01', '02', '03'].map(day => `.dickda/learning/2026-01-${day}-00-00-00`);
  const [consumed, ...pending] = dirs;
  for (const dir of dirs) {
    mkdirSync(join(work, dir, 'nested'), { recursive: true });
    writeFileSync(join(work, dir, 'nested/log.md'), `# Investigation\n${dir}\n`);
  }
  writeFileSync(join(work, CONSUMED_FILE), `${consumed}\n`);
  function checkReaders() {
    assert.deepEqual(backups(work), pending);
    assert.deepEqual(backups(work, 1, [pending[0]]), [pending[1]]);
    assert.equal(layerHealth(work).pendingArchives, pending.length);
    assert.deepEqual(assetsByKind(work, 'archives').map(doc => doc.path), pending.map(dir => `${dir}/nested/log.md`));
    const dashboard = buildDashboardData(work);
    assert.deepEqual(dashboard.archives, pending);
    assert.equal(dashboard.health.pendingArchives, pending.length);
  }
  checkReaders();
  const cli = (...args) => execFileSync(process.execPath, [cliScript, ...args, '--root', work], { env, encoding: 'utf8', stdio: 'pipe' });
  assert.equal(JSON.parse(cli('status')).pendingArchives, pending.length);
  assert.deepEqual(JSON.parse(cli('remember', '--earliest', '1')), [pending[0]]);
  assert.deepEqual(JSON.parse(cli('asset', 'list', 'archives')).map(doc => doc.path), pending.map(dir => `${dir}/nested/log.md`));
  assert.throws(() => cli('asset', 'show', `${consumed}/nested/log.md`), /资产不存在/);
  rmSync(join(work, consumed), { recursive: true });
  checkReaders();
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
    summary: 'Replace the manual check with documented practices',
    layers: ['L4'],
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

test('refine diagnosis requires declared layers, actionable work orders and nonempty L4 entries', () => {
  const diagnosis = { layers: ['L4'], summary: 'Record the investigation', learningUpdates: ['Retry on timeout'] };
  const job = { layer: 'L2', trade: 'architect', title: 'Check timeout', task: 'Add a lint' };
  for (const [invalid, error] of [
    [[], /JSON 对象/], [{ ...diagnosis, summary: ' ' }, /summary/],
    [{ ...diagnosis, layers: [] }, /layers/], [{ ...diagnosis, layers: ['L4', 'L5'] }, /layers/],
    [{ ...diagnosis, needsRefactor: true }, /actions/], [{ ...diagnosis, layers: ['L2'] }, /actions/],
    [{ ...diagnosis, actions: [job] }, /actions/],
    [{ ...diagnosis, layers: ['L2'], actions: [{ ...job, task: ' ' }] }, /actions/],
    [{ ...diagnosis, layers: ['L2'], actions: [{ ...job, trade: 'unknown' }] }, /actions/],
    [{ ...diagnosis, obsoleteProse: [' '] }, /obsoleteProse/],
    [{ ...diagnosis, learningUpdates: [{ text: ' ' }] }, /learningUpdates/],
    [{ ...diagnosis, learningUpdates: [{ text: 'note', file: 'Notes.md' }] }, /learningUpdates/],
    [{ ...diagnosis, knowledgeUpdates: [{ path: 'knowledge/doc.md', content: ' ' }] }, /知识更新/],
    [{ ...diagnosis, knowledgeUpdates: [{ path: 'knowledge/../tasks/doc.md', content: 'note' }] }, /知识更新/],
  ]) assert.throws(() => normalizeDiagnosis(invalid), error);
  assert.equal(normalizeDiagnosis({ ...diagnosis, layers: ['L2', 'L4'], actions: [job] }).needsRefactor, true);
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
  const leadPlan = xml.match(/<scriptTask id="lead-plan"[\s\S]*?<\/scriptTask>/)[0];
  const approvedHead = card('plan-confirm').match(/Approved HEAD \{\{([^}]+)\}\}/)[1];
  assert.equal(approvedHead, 'if think.head = null then seed.head else think.head');
  assert.ok(leadPlan.includes(`name="APPROVED_HEAD" value="=${approvedHead}"`));
  assert.ok(leadPlan.includes('name="FAST" value="=inputs.fast"'));
  assert.ok(leadPlan.includes('name="SEED_HEAD" value="=seed.head"'));
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
  const finalReview = xml.match(/<callActivity id="final-review"[\s\S]*?<\/callActivity>/)[0];
  const evidence = finalReview.match(/<coda:param name="evidence" value="([^"]+)"/)[1];
  assert.deepEqual([...evidence.matchAll(/\{\{([^}]+)\}\}/g)].map(match => match[1]), [
    'prepare-verify.evidence', 'dual-verify.report', 'dual-verify.evidence', 'dual-verify.findings',
  ]);
  assert.match(xml, /name="previous" value="=prepare-verify.previous"/);
  assert.match(xml, /name="VERIFY_EVIDENCE" value="=dual-verify.evidence"/);
  assert.match(xml, /name="VERIFY_FINDINGS" value="=dual-verify.findings"/);
  assert.equal(routes('verified-gate')['lead-plan'], '=verified-check.route = "lead"');
  assert.match(card('approve'), /approval-check.summary/);
});

for (const [script, step] of [[developScript, 'lane'], [refineScript, 'prepare']]) {
  test(`${step} rejects a non-default base before fetching it or writing workflow state`, t => {
    const { run, artifacts } = workflowFixture(t, script);
    assert.deepEqual(run(step, { BASE: 'release' }, /仅允许以仓库Default Branch main 作为目标分支.*release/), {});
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
  assert.match(seed.preview, /架构边界[\s\S]*…[\s\S]*Lint 规则[\s\S]*验证用例[\s\S]*并发Work Order[\s\S]*Human Review/);

  for (const note of ['交互者要求补充验收入口', '用户要求改动并发边界']) {
    run('plan-feedback', { FEEDBACK: note });
    assert.equal(state().planFeedback, note);
    writeFileSync(join(work, plan), blueprint + '\n' + note);
    const head = commit(work, 'revise plan');
    const revised = run('think', { AGENT_REPLY: JSON.stringify({ session: 'think', head }) });
    assert.equal(revised.head, head);
    assert.ok(revised.preview.includes(note));
    assert.ok(readFileSync(join(dir, 'tmp/thinker.md'), 'utf8').includes('Interactor/用户修订意见\n' + note));
    assert.equal(state().planFeedback, '');
  }
  const summary = join(dir, 'summary');
  const stop = run('stopped', { REASON: '等产品确认范围', GITHUB_STEP_SUMMARY: summary });
  assert.equal(state().stopReason, stop.reason);
  assert.match(readFileSync(summary, 'utf8'), /等产品确认范围/);
  assert.equal(git(origin, 'rev-parse', lane.reqBranch), state().head);
  assert.match(run('stopped', { REASON: '' }).reason, /暂不开工/);
});

test('think rejects business changes anywhere in the proposed diff before publishing the plan', t => {
  const { work, origin, git, commit, run, state } = workflowFixture(t);
  const { reqBranch } = run('lane', { GOAL: '规划登录入口' });
  const seed = run('seed');
  git(work, 'fetch', 'origin', reqBranch);
  git(work, 'checkout', '--detach', seed.head);
  writeFileSync(join(work, 'feature.mjs'), 'export const ready = true;\n');
  commit(work, 'implement feature before approval');
  writeFileSync(join(work, '.dickda/tasks/PLAN_5L.md'), blueprint);
  const head = commit(work, 'write plan');
  run('think', { AGENT_REPLY: JSON.stringify({ head }) }, /只可修改 \.dickda\/tasks\/PLAN_5L\.md.*feature\.mjs/);
  assert.equal(git(origin, 'rev-parse', reqBranch), seed.head);
  assert.equal(state().head, seed.head);
});

test('first dispatch checks the approved revision against the remote head before calling the lead', t => {
  const { work, dir, artifacts, git, commit, run, lead, state } = workflowFixture(t);
  const { reqBranch } = run('lane', { GOAL: '规划登录入口' });
  const seed = run('seed');
  git(work, 'fetch', 'origin', reqBranch);
  git(work, 'checkout', '--detach', seed.head);
  const plan = join(work, '.dickda/tasks/PLAN_5L.md');
  function propose(body) {
    writeFileSync(plan, body);
    return run('think', { AGENT_REPLY: JSON.stringify({ head: commit(work, 'propose plan') }) });
  }
  const original = propose(blueprint);
  run('plan-feedback', { FEEDBACK: '补上离线场景' });
  const revised = propose(blueprint + '\n离线场景须显示错误提示。');
  const start = { FAST: 'false', SEED_HEAD: seed.head, APPROVED_HEAD: revised.head };
  const dispatch = { action: 'dispatch', jobs: [{ id: 'login', trade: 'builder', title: '登录入口', task: '实现登录' }] };
  lead(dispatch, new RegExp(`基线提交不一致.*${original.head}.*${revised.head}`), { ...start, APPROVED_HEAD: original.head });

  writeFileSync(join(work, 'feature.mjs'), 'export const external = true;\n');
  const external = commit(work, 'advance remote while the card is pending');
  const ref = `refs/heads/${reqBranch}`;
  git(work, 'push', 'origin', `${external}:${ref}`);
  lead(dispatch, new RegExp(`基线提交不一致.*${revised.head}.*${external}`), start);
  lead(dispatch, new RegExp(`基线提交不一致.*${seed.head}.*${external}`), { FAST: 'true', SEED_HEAD: seed.head, APPROVED_HEAD: seed.head });
  assert.equal(state().round, 0);
  assert.ok(!existsSync(join(dir, 'tmp/lead-1.md')));
  assert.ok(!existsSync(join(artifacts, 'batch-1.json')));

  git(work, 'push', `--force-with-lease=${ref}:${external}`, 'origin', `${revised.head}:${ref}`);
  assert.equal(lead(dispatch, undefined, start).route, 'dispatch');
  assert.equal(state().approvedPlanHead, revised.head);
});

test('a matching explicit goal can start on the reused plan and a new goal resets it', t => {
  const { dir, work, origin, git, commit, run, lead } = workflowFixture(t);
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
    assert.equal(lead({ action: 'verify' }, undefined, {
      CODA_ARTIFACTS: join(dir, id), GITHUB_RUN_ID: id, FAST: 'false', SEED_HEAD: start, APPROVED_HEAD: reused.head,
    }).route, 'verify');
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
  const { run, seedFast, lead, state, artifacts } = workflowFixture(t);
  run('lane', { GOAL: '交付新入口' });
  const { head } = seedFast();
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
  assert.doesNotMatch(failure.reason, /Independent Code Review/);
  for (const detail of ['这次入口失败', 'entry.png', '按钮文案']) assert.ok(state().pendingFeedback.includes(detail));
  assert.equal(state().verifiedHead, '');
  assert.equal(run('prepare-verify').skipReview, 'false');
  const lost = run('verified', { VERIFY_REPORT: 'dickda-verify 调用异常，请查看子流程' });
  assert.equal(lost.route, 'lead');
  assert.match(state().pendingFeedback, /调用异常/);
});

test('incremental review numbers new musts, preserves upheld ids and falls back for incomplete findings', t => {
  const { work, git, commit, run, seedFast, lead } = workflowFixture(t);
  const lane = run('lane', { GOAL: '增量复评' });
  let { head } = seedFast();
  assert.equal(lead({ action: 'verify' }).route, 'verify');
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

test('integrate reconciles the round snapshot with result files and their IDs before publishing any work', t => {
  const { work, origin, artifacts, git, commit, run, seedFast, lead, state } = workflowFixture(t);
  const { reqBranch } = run('lane', { GOAL: '实现并验收入口' });
  const seed = seedFast();
  const { round } = lead({ action: 'dispatch', jobs: [
    { id: 'ui', trade: 'verifier', title: '验收入口', task: '验证入口可见' },
    { id: 'entry', trade: 'builder', title: '实现入口', task: '新增入口' },
  ] });
  git(work, 'fetch', 'origin', reqBranch);
  git(work, 'checkout', '--detach', seed.head);
  writeFileSync(join(work, 'feature.mjs'), 'export const ready = true;\n');
  const head = commit(work, 'implement entry');
  run('worker', { JOB_ID: 'entry', AGENT_REPLY: JSON.stringify({ session: 'builder', head }) });
  run('integrate', {}, /派发 \[entry, ui\]，回收 \[entry\]/);
  assert.equal(git(origin, 'rev-parse', reqBranch), seed.head);
  assert.deepEqual(state().ledger, {});

  const resultFile = id => join(artifacts, 'workers', `${round}-${id}.json`);
  writeFileSync(resultFile('other'), JSON.stringify({ id: 'other' }));
  run('integrate', {}, /派发 \[entry, ui\]，回收 \[entry, other\]/);
  run('worker', { JOB_ID: 'ui', AGENT_REPLY: JSON.stringify({ session: 'verifier', answer: '```json\n{"passed":true}\n```' }) });
  run('integrate', {}, /派发 \[entry, ui\]，回收 \[entry, other, ui\]/);
  unlinkSync(resultFile('other'));
  const ui = readFileSync(resultFile('ui'));
  writeFileSync(resultFile('ui'), readFileSync(resultFile('entry')));
  run('integrate', {}, /ui\.json.*ID entry 不一致/);
  writeFileSync(resultFile('ui'), ui);
  assert.equal(run('integrate').head, head);
  assert.equal(state().ledger.ui.status, 'verified');
});

test('must findings on verifier jobs block verification until exact-ID retries, replacements or reasoned waivers', t => {
  const { run, seedFast, lead, state } = workflowFixture(t);
  run('lane', { GOAL: '验收登录、结算与旧入口' });
  seedFast();
  const job = id => ({ id, trade: 'verifier', title: id, task: '检查入口能否提交' });
  function worker(id, findings) {
    const verdict = { passed: true, summary: findings.length ? '提交没有响应' : '提交成功', findings };
    return run('worker', { JOB_ID: id, AGENT_REPLY: JSON.stringify({ session: 'verifier', answer: '```json\n' + JSON.stringify(verdict) + '\n```' }) }).status;
  }
  const must = [{ level: 'must', title: '提交没有响应', detail: '点击提交后仍停留在表单' }];
  const ids = ['login', 'checkout', 'legacy'];
  lead({ action: 'dispatch', jobs: ids.map(job) });
  for (const id of ids) {
    const findings = id === 'legacy' ? must : [...must, { level: 'must', title: '重试丢失表单' }];
    assert.equal(worker(id, findings), 'rejected');
  }
  run('integrate');
  lead({ action: 'verify' }, /验证Work Order：checkout.*重派.*ignoredFindings/);

  const beforeRetry = state().ledger;
  const retries = JSON.parse(lead({ action: 'dispatch', jobs: [job('login'), { ...job('checkout-2'), replaces: 'checkout' }] }).jobs);
  for (const retry of retries) assert.deepEqual(retry.openMusts, beforeRetry[retry.replaces ?? retry.id].openMusts);
  assert.equal(worker('login', []), 'succeeded');
  assert.equal(worker('checkout-2', [
    { ...must[0], id: 'checkout#1', detail: '重试时仍无响应' },
    must[0],
    { level: 'must', title: '结算金额错误' },
  ]), 'rejected');
  run('integrate');
  assert.equal(state().ledger.login.status, 'verified');
  assert.deepEqual(state().ledger.login.openMusts, []);
  assert.equal(state().ledger.checkout.status, 'rejected');
  assert.deepEqual(state().ledger.checkout.openMusts, []);
  const checkoutIds = state().ledger['checkout-2'].openMusts.map(f => f.id).sort();
  assert.deepEqual(checkoutIds, ['checkout#1', 'checkout#2', 'checkout-2#1', 'checkout-2#2']);
  lead({
    action: 'verify', ignoredFindings: checkoutIds.map(id => ({ id, reason: '结算入口已从本次方案移除' })),
  }, /仍有被打回的验证Work Order：legacy 缺少 legacy#1 提交没有响应 的依据。请重派/);
  lead({ action: 'dispatch', jobs: [{ ...job('checkout-3'), replaces: 'checkout-2' }] });
  assert.equal(worker('checkout-3', []), 'succeeded');
  run('integrate');
  const { ledger } = state();
  assert.equal(ledger['checkout-3'].status, 'verified');
  for (const id of ['checkout', 'checkout-2']) {
    assert.equal(ledger[id].status, 'replaced');
    assert.equal(ledger[id].replacedBy, 'checkout-3');
    assert.deepEqual(ledger[id].openMusts, []);
  }

  const waiver = { id: 'legacy', reason: '确认的方案已移除旧入口' };
  lead({ action: 'verify', ignoredFindings: [{ ...waiver, id: 'Legacy' }] }, /验证Work Order：legacy/);
  lead({ action: 'verify', ignoredFindings: [{ ...waiver, reason: '  ' }] }, /ignoredFindings.*非空/);
  assert.equal(lead({ action: 'verify', ignoredFindings: [waiver] }).route, 'verify');
  assert.deepEqual(state().ignoredFindings, [waiver]);

  const lost = { level: 'must', title: '保存丢数据' };
  lead({ action: 'dispatch', jobs: [job('legacy')] });
  worker('legacy', [...must, lost]);
  run('integrate');
  lead({ action: 'dispatch', jobs: [job('legacy')], ignoredFindings: [waiver] });
  worker('legacy', [lost]);
  run('integrate');
  lead({ action: 'verify' }, /legacy#2 保存丢数据/);
  assert.equal(lead({ action: 'verify', ignoredFindings: [{ id: 'legacy#2', reason: '回读测试已覆盖该场景' }] }).route, 'verify');
});

test('verifier musts with explicit IDs only claim an exact historical ID once per round', () => {
  const ledger = {};
  const must = { level: 'must', title: '保存失败', detail: '提交后回读为空' };
  function report(findings) {
    const job = { id: 'audit', trade: 'verifier', status: 'rejected', findings };
    const result = integrateWorkerResults(repoRoot, 'HEAD', [job], ledger);
    return result.ledger.audit.openMusts.map(f => f.id);
  }

  assert.deepEqual(report([{ ...must, id: 'worker-a' }, { ...must, id: 'worker-b' }]), ['audit#1', 'audit#2']);
  const second = { ...must, id: 'audit#2' };
  assert.deepEqual(report([{ ...must, id: 'worker-c' }, second, second, must, must]), [
    'audit#3', 'audit#2', 'audit#4', 'audit#1', 'audit#5',
  ]);
});

test('same-title verifier musts at different locations stay open and resolve independently', t => {
  const { run, seedFast, lead, state, env } = workflowFixture(t);
  run('lane', { GOAL: '验收订单和用户保存' });
  seedFast();
  const job = { id: 'audit', trade: 'verifier', title: '验证保存', task: '复测订单和用户的保存结果' };
  const orders = { title: '保存失败', detail: '提交后回读为空', location: 'src/orders.mjs:20' };
  const users = { ...orders, location: 'src/users.mjs:40' };
  const first = { id: 'audit#1', ...orders };
  const second = { id: 'audit#2', ...users };
  const open = () => state().ledger.audit.openMusts;
  function report(findings, resolved = []) {
    lead({ action: 'dispatch', jobs: [job] });
    const verdict = { passed: false, findings: findings.map(f => ({ level: 'must', ...f })), resolved };
    const answer = '```json\n' + JSON.stringify(verdict) + '\n```';
    run('worker', { JOB_ID: job.id, AGENT_REPLY: JSON.stringify({ session: 'verifier', answer }) });
    run('integrate');
  }

  report([{ ...orders, location: ` ${orders.location} ` }, users]);
  assert.deepEqual(open(), [first, second]);
  const feedback = state().pendingFeedback;
  const missingUsers = /缺少 audit#2 .*src\/users\.mjs:40/;
  lead({ action: 'verify', ignoredFindings: [{ id: first.id, reason: '订单入口已通过回读复核' }] }, missingUsers);

  report([users]);
  assert.deepEqual(open(), [second, first]);
  const prompt = readFileSync(join(env.RUNNER_TEMP, 'worker-audit.md'), 'utf8');
  for (const { id, title, location } of [first, second]) {
    assert.ok(feedback.includes(`${id} [must] ${title}（${location}）`));
    assert.ok(prompt.includes(`"location": "${location}"`));
  }

  report([], [first.id]);
  assert.deepEqual(open(), [second]);
  lead({ action: 'verify' }, missingUsers);
});

test('two musts on one verifier require separate rulings across lead rounds', t => {
  const { run, seedFast, lead, state, env } = workflowFixture(t);
  run('lane', { GOAL: '验收保存流程' });
  seedFast();
  const job = { id: 'ver-1', trade: 'verifier', title: '验证保存', task: '检查两个入口的保存结果' };
  const first = { level: 'must', title: '旧入口无响应', detail: '提交后停留在旧表单' };
  const second = { level: 'must', title: '保存丢数据', detail: '重新打开后为空' };
  function report(findings) {
    const verdict = { passed: false, findings };
    run('worker', { JOB_ID: job.id, AGENT_REPLY: JSON.stringify({ session: 'verifier', answer: '```json\n' + JSON.stringify(verdict) + '\n```' }) });
    run('integrate');
  }
  lead({ action: 'dispatch', jobs: [job] });
  report([first, { level: 'nit', title: '按钮文案' }, second]);
  const ids = () => state().ledger[job.id].openMusts.map(f => f.id);
  assert.deepEqual(ids(), ['ver-1#1', 'ver-1#2']);
  assert.match(state().pendingFeedback, /ver-1#1 \[must\] 旧入口无响应/);
  assert.match(state().pendingFeedback, /ver-1#2 \[must\] 保存丢数据/);

  const oldEntry = { id: 'ver-1#1', reason: '已批准的方案移除了旧入口' };
  const save = { id: 'ver-1#2', reason: '回读测试确认已保存，复现使用了清空数据的测试夹具' };
  const missing = /ver-1#2 保存丢数据/;
  const wholeJob = { id: job.id, reason: oldEntry.reason };
  for (const ignoredFindings of [[wholeJob], [oldEntry], [oldEntry, wholeJob], [oldEntry, oldEntry]]) {
    lead({ action: 'verify', ignoredFindings }, missing);
  }
  const prompt = readFileSync(join(env.RUNNER_TEMP, 'lead-2.md'), 'utf8').split('## 最新待裁决反馈')[0];
  assert.match(prompt, /ver-1#1 旧入口无响应/);
  assert.match(prompt, missing);

  lead({ action: 'dispatch', jobs: [job], ignoredFindings: [oldEntry] });
  report([second, first]);
  assert.deepEqual(ids(), ['ver-1#2', 'ver-1#1']);
  lead({ action: 'verify' }, missing);
  assert.equal(lead({ action: 'verify', ignoredFindings: [save] }).route, 'verify');
  assert.deepEqual(state().ignoredFindings, [oldEntry, save]);
});

test('failed verifier retries preserve both musts at the verify gate', t => {
  const { run, seedFast, lead, state, env } = workflowFixture(t);
  run('lane', { GOAL: '验收保存流程' });
  seedFast();
  const job = { id: 'save', trade: 'verifier', title: '保存验证', task: '检查提交与回读' };
  const verdict = value => '```json\n' + JSON.stringify(value) + '\n```';
  function attempt(answer, expectedStatus, exitCode = '0') {
    lead({ action: 'dispatch', jobs: [job] });
    const result = run('worker', {
      JOB_ID: job.id, AGENT_EXIT_CODE: exitCode, AGENT_REPLY: JSON.stringify({ session: 'verifier', answer }),
    });
    assert.equal(result.status, expectedStatus);
    run('integrate');
  }

  attempt(verdict({ passed: false, findings: [
    { level: 'must', title: '重复提交', detail: '一次点击写入两次' },
    { level: 'must', title: '保存丢数据', detail: '重新打开后为空' },
  ] }), 'rejected');
  const original = state().ledger.save.openMusts;
  assert.deepEqual(original.map(f => f.id), ['save#1', 'save#2']);
  const verify = { action: 'verify', ignoredFindings: [{ id: job.id, reason: '旧入口已移除' }] };
  for (const [answer, exitCode] of [[verdict({ passed: true, resolved: ['save#1'] }), '1'], ['未返回结构化结论', '0']]) {
    attempt(answer, 'failed', exitCode);
    lead(verify, /save#1 重复提交.*save#2 保存丢数据/);
    assert.deepEqual(state().ledger.save.openMusts, original);
  }

  attempt(verdict({ passed: false, findings: [] }), 'rejected');
  assert.deepEqual(state().ledger.save.openMusts, original);
  lead(verify, /save#1 重复提交.*save#2 保存丢数据/);
  const workerPrompt = readFileSync(join(env.RUNNER_TEMP, 'worker-save.md'), 'utf8');
  const ledgerSummary = readFileSync(join(env.RUNNER_TEMP, `lead-${state().round + 1}.md`), 'utf8').split('## 最新待裁决反馈')[0];
  assert.match(workerPrompt, /"resolved"/);
  for (const { id, title, detail } of original) {
    for (const text of [id, title, detail]) assert.ok(workerPrompt.includes(text), text);
    assert.ok(state().pendingFeedback.includes(`${id} [must] ${title}：${detail}`));
    assert.ok(ledgerSummary.includes(`${id} ${title}`));
  }

  attempt(verdict({ passed: false, resolved: ['save#1'], findings: [] }), 'rejected');
  assert.deepEqual(state().ledger.save.openMusts, [original[1]]);
  assert.doesNotMatch(state().pendingFeedback, /save#1/);
  assert.match(state().pendingFeedback, /save#2 \[must\] 保存丢数据/);
  const waiver = { id: 'save#2', reason: '回读测试确认数据已保存' };
  assert.equal(lead({ action: 'verify', ignoredFindings: [waiver] }).route, 'verify');

  attempt(verdict({ passed: true, summary: '已修复', findings: [] }), 'succeeded');
  assert.deepEqual(state().ledger.save.openMusts, []);
  assert.equal(state().ledger.save.status, 'verified');
  assert.equal(lead({ action: 'verify' }).route, 'verify');
});

test('cancelled coding jobs retain strict descendant commits for redispatch without integrating them', t => {
  const { work, origin, git, commit, run, seedFast, lead, state } = workflowFixture(t);
  const { reqBranch } = run('lane', { GOAL: '实现入口' });
  const { head: base } = seedFast();
  const sibling = commit(work, 'work on another branch');
  git(work, 'fetch', 'origin', reqBranch);
  git(work, 'checkout', '--detach', 'FETCH_HEAD');
  writeFileSync(join(work, 'entry.mjs'), 'export const ready = false;\n');
  const partial = commit(work, 'partial implementation');
  const job = { id: 'entry', trade: 'builder', title: '入口', task: '实现入口' };
  lead({ action: 'dispatch', jobs: [job, { ...job, id: 'check', trade: 'verifier' }] });
  assert.equal(state().approvedPlanHead, base);
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
  const { work, origin, git, commit, env, run, seedFast, lead, state } = workflowFixture(t);
  init(work);
  writeFileSync(join(work, '.dickda/lints/check.sh'), 'test ! -f blocked.txt\n');
  git(work, 'push', 'origin', `${commit(work, 'base lint')}:main`);
  const { reqBranch } = run('lane', { GOAL: '实现入口' });
  seedFast();
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
  lead({ action: 'verify' }, /被打回的编码Work Order：entry/);
  lead({ action: 'verify', ignoredFindings: [{ id: 'other', reason: '无关项' }] }, /被打回的编码Work Order：entry/);
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
  const { work, origin, git, commit, run, seedFast, lead, state } = workflowFixture(t);
  const { reqBranch } = run('lane', { GOAL: '并发实现' });
  seedFast();
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
  refine('prepare');
  assert.equal(attempt(refine, 'collect', 'fetch', 9, 'fatal: early EOF', /early EOF/), 3);
  assert.equal(attempt(refine, 'collect', 'push', 1, 'Connection reset by peer'), 2);
});

test('full dickda lifecycle persists investigation archive onto delivery branch across ephemeral step worktrees', t => {
  const { dir, origin, env, git, ghCallsFile, run: runIsolatedStep, state } = workflowFixture(t);

  const fakeCodaAgent = join(dir, 'bin/coda-agent');
  writeFileSync(fakeCodaAgent, `#!${process.execPath}
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const args = process.argv.slice(2);
const promptFile = args[args.indexOf('--prompt-file') + 1];
const prompt = fs.readFileSync(promptFile, 'utf8');
const git = (...a) => execFileSync('git', a, { encoding: 'utf8' }).trim();

if (prompt.includes('# Role: Thinker')) {
  fs.writeFileSync('.dickda/tasks/PLAN_5L.md', ${JSON.stringify(blueprint)});
  git('add', '.dickda/tasks/PLAN_5L.md');
  git('commit', '-m', 'docs(dickda): add 5-layer blueprint');
  console.log(JSON.stringify({ session: 'think-1', branch: 'b', head: git('rev-parse', 'HEAD'), answer: 'Blueprint ready' }));
} else if (prompt.includes('Lead决策上下文')) {
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
  const seed = runIsolatedStep('seed');
  const thought = runIsolatedStep('think');
  const start = { FAST: 'false', SEED_HEAD: seed.head, APPROVED_HEAD: thought.head };

  const wave1 = runIsolatedStep('lead-plan', start);
  assert.equal(wave1.route, 'dispatch');
  assert.equal(state().approvedPlanHead, thought.head);
  assert.equal(wave1.session, 'interactor-session');
  assert.equal(wave1.milestone, 'Dispatch wave 1');
  runIsolatedStep('worker', { JOB_ID: 'impl-1' });
  const integrated = runIsolatedStep('integrate');
  assert.equal(integrated.changed, 'true');

  const wave2 = runIsolatedStep('lead-plan', start);
  assert.equal(wave2.route, 'verify');
  assert.equal(state().approvedPlanHead, thought.head);
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
    VERIFY_REPORT: 'Dual-Track Verification全绿',
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

  runRefineStep('prepare');
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
  writeFileSync(join(work, '.dickda/lints/healthy.sh'), 'test ! -e .dickda/knowledge/Broken.md\n');
  if (broken) writeFileSync(join(work, '.dickda/knowledge/Broken.md'), 'failed check\n');
  writeFileSync(join(work, '.dickda/tasks/logs/worker.md'), '入口调查\n');
  const { path: archive } = remember(work);
  const original = commit(work, 'seed investigation batch');
  git(work, 'push', 'origin', 'main');
  run('prepare');
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

test('queued collects refresh main after the lock and skip consumed archives even on a diverged starting branch', t => {
  const fixture = refineFixture(t);
  const { dir, work, origin, env, git, commit, original, archive, branch, run, state } = fixture;
  git(work, 'branch', 'behind', original);
  git(work, 'checkout', '-b', 'topic', original);
  writeFileSync(join(work, '.dickda/tasks/logs/topic.md'), 'Topic investigation\n');
  const topicArchive = remember(work).path;
  const topic = commit(work, 'investigate on topic');
  git(work, 'push', 'origin', 'behind', 'topic');
  git(work, 'checkout', 'main');

  // Every queued checkout sees only the refs and objects available before the first run consumed its archive.
  const snapshot = join(dir, 'before-lock.git');
  git(work, 'clone', '--bare', '-q', origin, snapshot);
  function queue(id, startingBranch) {
    const artifacts = join(dir, id);
    mkdirSync(artifacts);
    const queued = stepRunner({ ...fixture, origin: snapshot, env: {
      ...env, CODA_ARTIFACTS: artifacts, GITHUB_RUN_ID: id, RUN_COMMIT: original, BRANCH: startingBranch,
    } }, refineScript);
    assert.equal(queued('prepare').group, state().group);
    const ref = `dickda/refine-${id}`;
    assert.equal(git(origin, 'branch', '--list', ref), '');
    return (expectedHead, expectedArchive) => {
      assert.deepEqual(queued('collect'), { hasArchive: String(Boolean(expectedArchive)), archive: expectedArchive });
      const saved = JSON.parse(readFileSync(join(artifacts, 'refine.json'), 'utf8'));
      assert.equal(saved.baseCommit, git(origin, 'rev-parse', 'main'));
      assert.equal(saved.startHead, expectedHead);
      if (expectedArchive) assert.equal(git(origin, 'rev-parse', ref), expectedHead);
      else assert.equal(git(origin, 'branch', '--list', ref), '');
    };
  }
  const empty = queue('empty', '');
  const onMain = queue('on-main', 'main');
  const behind = queue('on-behind', 'behind');
  const diverged = queue('on-topic', 'topic');
  const first = run('execute').head;
  git(work, 'fetch', 'origin', branch);
  git(work, 'merge', '--ff-only', first);
  git(work, 'push', 'origin', 'main');
  assert.equal(git(origin, 'ls-tree', 'main', '--', archive), '');
  empty(first, '');

  writeFileSync(join(work, '.dickda/tasks/logs/next.md'), 'Next investigation on main\n');
  const next = remember(work, new Date(2030, 0, 1)).path;
  const latest = commit(work, 'add next investigation');
  git(work, 'push', 'origin', 'main');
  onMain(latest, next);
  behind(latest, next);
  diverged(topic, topicArchive);
});

for (const method of ['squash', 'rebase']) {
  test(`refining a retained topic after a ${method} merge keeps both consumed archives off main`, t => {
    const fixture = workflowFixture(t, refineScript);
    const { dir, work, origin, env, git, commit } = fixture;
    const snapshot = join(dir, 'before-refinements.git');
    git(work, 'clone', '--bare', '-q', origin, snapshot);
    const run = stepRunner({ ...fixture, origin: snapshot }, refineScript);
    init(work);
    function archiveOn(day) {
      writeFileSync(join(work, '.dickda/tasks/logs/worker.md'), `Investigation ${day}\n`);
      return remember(work, new Date(2026, 0, day)).path;
    }
    function collect(id) {
      env.CODA_ARTIFACTS = join(dir, id);
      env.GITHUB_RUN_ID = id;
      mkdirSync(env.CODA_ARTIFACTS);
      run('prepare');
      return run('collect', { BRANCH: 'topic' });
    }
    function execute(file, note) {
      const diagnosis = { layers: ['L4'], summary: 'Document findings', learningUpdates: [{ file, text: note }] };
      run('diagnose', { AGENT_REPLY: JSON.stringify({ answer: '```json\n' + JSON.stringify(diagnosis) + '\n```' }) });
      run('decide', { DECISION: '{"choice":"prose"}' });
      return run('execute').head;
    }

    const legacy = archiveOn(1);
    const ancestor = commit(work, 'shared historical archive');
    git(work, 'branch', 'topic');
    git(work, 'rm', '-r', legacy);
    commit(work, 'consume shared archive before consumption records existed');
    git(work, 'push', 'origin', 'main');
    git(work, 'checkout', 'topic');
    const archive = archiveOn(2);
    commit(work, 'topic-only investigation');
    git(work, 'push', 'origin', 'topic');
    assert.deepEqual(collect('first'), { hasArchive: 'true', archive });
    const candidate = execute('Learning_Retry.md', 'Keep the retry contract');
    git(work, 'fetch', 'origin', 'dickda/refine-first');
    git(work, 'checkout', 'main');
    if (method === 'squash') {
      git(work, 'merge', '--squash', candidate);
      git(work, 'commit', '-m', 'squash refinement');
    } else {
      git(work, 'rebase', 'main', candidate);
      const rebased = git(work, 'rev-parse', 'HEAD');
      git(work, 'checkout', 'main');
      git(work, 'merge', '--ff-only', rebased);
    }
    git(work, 'push', 'origin', 'main');
    assert.equal(git(work, 'merge-base', 'main', 'topic'), ancestor);
    assert.equal(git(origin, 'show', `main:${CONSUMED_FILE}`), archive);
    assert.deepEqual(collect('empty'), { hasArchive: 'false', archive: '' });

    git(work, 'checkout', 'topic');
    const next = archiveOn(3);
    commit(work, 'new investigation on retained topic');
    git(work, 'push', 'origin', 'topic');
    assert.deepEqual(collect('next'), { hasArchive: 'true', archive: next });
    const nextCandidate = execute('Learning_Outcomes.md', 'Document retry outcomes');
    assert.equal(git(origin, 'show', `${nextCandidate}:${CONSUMED_FILE}`), `${archive}\n${next}`);
    git(work, 'fetch', 'origin', 'dickda/refine-next');
    git(work, 'checkout', 'main');
    // Both sides added .consumed. Keep the candidate's combined record when squashing.
    git(work, 'merge', '--squash', '-X', 'theirs', nextCandidate);
    git(work, 'commit', '-m', 'squash second refinement');
    git(work, 'push', 'origin', 'main');
    assert.equal(git(origin, 'ls-tree', 'main', '--', archive, next), '');
    assert.equal(git(origin, 'show', `main:${CONSUMED_FILE}`), `${archive}\n${next}`);
  });
}

test('invalid diagnosis stops the workflow and ineffective plans leave the archive and candidate commit intact', t => {
  const { work, origin, git, commit, run, state } = workflowFixture(t, refineScript);
  init(work);
  writeFileSync(join(work, '.dickda/tasks/logs/worker.md'), 'Investigation\n');
  const archive = remember(work).path;
  const original = commit(work, 'pending archive');
  git(work, 'push', 'origin', 'main');
  run('prepare');
  run('collect');
  const branch = state().refineBranch;
  const jsonBlock = value => '```json\n' + JSON.stringify(value) + '\n```';
  const reply = answer => ({ AGENT_REPLY: JSON.stringify({ answer }) });
  for (const [answer, error] of [
    ['无法完成诊断', /JSON 对象/], [jsonBlock(null), /JSON 对象/],
    [jsonBlock({ layers: ['L4'], summary: 'Empty', actions: [], learningUpdates: [] }), /没有可落地/],
  ]) {
    run('diagnose', reply(answer), error);
    assert.equal(state().diagnosis, undefined);
    assert.equal(git(origin, 'rev-parse', branch), original);
  }
  run('diagnose', reply(jsonBlock({
    layers: ['L1'], summary: 'Refactor the entry point',
    actions: [{ layer: 'L1', trade: 'builder', title: 'Entry point', task: 'Refactor app.mjs' }],
  })));
  run('decide', { DECISION: '{"choice":"prose"}' });
  run('execute', {}, /没有产生实质文件变更/);
  assert.equal(git(origin, 'rev-parse', branch), original);
  assert.ok(git(origin, 'ls-tree', 'main', '--', archive));

  // Updating only the consumption record still fails before deleting the archive.
  writeFileSync(join(work, CONSUMED_FILE), `${archive}\n`);
  const recordOnly = commit(work, 'record a batch without refining it');
  for (const choice of ['prose', 'refactor']) {
    assert.throws(() => executeRefinePlan(work, { ...state(), head: recordOnly, choice,
      diagnosis: normalizeDiagnosis({ layers: ['L4'], summary: 'Prune note', obsoleteProse: ['never recorded'] }),
    }), /没有产生实质文件变更/);
    assert.ok(existsSync(join(work, archive)));
    assert.equal(git(work, 'rev-parse', 'HEAD'), recordOnly);
  }
  writeFileSync(join(work, 'app.mjs'), 'export const answer = () => 43;\n');
  const changedHead = commit(work, 'candidate advanced before execution');
  assert.throws(() => executeRefinePlan(work, {
    ...state(), head: changedHead, diagnosis: { learningUpdates: ['Retry on timeout'], layers: ['L4'] },
  }), /仅更新 L4.*app\.mjs/);
  assert.ok(existsSync(join(work, archive)));
});

test('refine scope permits only deletions in consumed archives and requires a substantive change elsewhere', t => {
  const { work, git, commit } = createGitRepo(t);
  init(work);
  const [previous, archive] = ['01', '02'].map(day => `.dickda/learning/2026-01-${day}-00-00-00`);
  for (const dir of [previous, archive]) {
    mkdirSync(join(work, dir));
    writeFileSync(join(work, dir, 'log.md'), 'Investigation\n');
  }
  const startHead = commit(work, 'topic still carries the previously consumed archive');
  const plan = { startHead, baseConsumed: [previous], archive, refineBranch: 'refine', diagnosis: { layers: ['L4'] } };
  function reject(head, error) {
    for (const choice of ['prose', 'refactor']) {
      assert.throws(() => executeRefinePlan(work, { ...plan, head, choice }), error);
    }
  }
  git(work, 'rm', '-r', previous);
  reject(commit(work, 'only remove consumed files'), /没有产生实质文件变更/);

  for (const path of [`${previous}/added.md`, `${archive}/log.md`]) {
    git(work, 'checkout', '--detach', startHead);
    writeFileSync(join(work, '.dickda/knowledge/Entry.md'), '# Retry contract\n');
    writeFileSync(join(work, path), 'Edited investigation\n');
    reject(commit(work, 'edit an archive alongside a prose change'), new RegExp(`已消费的归档仅允许删除：${RegExp.escape(path)}`));
    assert.ok(existsSync(join(work, path)));
  }
});

test('refine routes hook failures, incomplete reviews, human decisions and conflicts before merging', () => {
  const { xml, routes, card } = workflowGraph('dickda-refine');
  assert.deepEqual(routes('start'), { prepare: 'always' });
  assert.deepEqual(routes('prepare'), { hold: 'always' });
  assert.match(xml, /id="hold"[^>]*coda:action="hold-group">[\s\S]*?name="group" value="=prepare.group"[\s\S]*?name="exclusive" value="true"[\s\S]*?name="borrow" value="no"/);
  assert.deepEqual(routes('hold'), { collect: 'always' });
  assert.deepEqual(routes('collect'), { 'has-archive': 'always' });
  assert.deepEqual(routes('has-archive'), { diagnose: '=collect.hasArchive = true', 'empty-done': 'always' });
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
    assert.match(binding, /^=\{r: if /);
    assert.match(binding, /reviewer: if r\.agent = "antigravity" then context put\(r, "mode", "full"\) else r\}\.reviewer$/);
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
  assert.match(card('approve'), /name="批准合并五层Refine PR" coda:assignee="user"/);
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
  writeFileSync(join(work, '.dickda/knowledge/Attempt.md'), 'still broken');
  run('repair', reply(commit(work, 'repair still fails lint')), /L2\/L3 验证未通过/);
  assert.equal(tip(), original);
  checkoutCandidate();
  writeFileSync(join(work, 'app.mjs'), 'export const answer = () => 0;\n');
  run('repair', reply(commit(work, 'change code during prose repair')), /仅更新 L4.*app\.mjs/);
  run('repair', {}, /自动修复已达 3 次/);
  run('continue-repair', { NOTE: '清理失效文档并保留入口约定' });
  assert.match(state().failure, /清理失效文档/);
  checkoutCandidate();
  unlinkSync(join(work, '.dickda/knowledge/Broken.md'));
  const fixed = run('repair', reply(commit(work, 'fix lint')));
  assert.equal(tip(), fixed.head);
  assert.equal(git(origin, 'ls-tree', fixed.head, '--', archive), '');
  assert.match(git(origin, 'show', `${fixed.head}:.dickda/learning/Learning_General.md`), /入口须可重试/);
  assert.ok(git(origin, 'ls-tree', 'main', '--', archive));
  for (const step of ['项目检查', 'Premerge Checks', 'GitHub 检查']) {
    run('failed', { STEP: step, LINES: 'smoke failed' });
    assert.ok(state().failure.includes(step));
    assert.match(state().failure, /smoke failed/);
  }
  checkoutCandidate();
  writeFileSync(join(work, '.dickda/knowledge/Smoke.md'), '# Smoke check\n');
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
    run('deliver', {}, /Independent Code Review/);
  }
  const entryDoc = '.dickda/knowledge/Entry.md';
  const finding = { level: 'must', kind: 'contract', title: '入口文档', location: entryDoc, detail: '缺少入口的重试约定' };
  const review = (head, decision, fields = {}, previous = '') => run('reviewed', {
    REVIEW: JSON.stringify({ head, decision, ...fields }), PREVIOUS: previous,
  });
  assert.equal(review(first, 'REQUEST_CHANGES', { findings: JSON.stringify([finding]) }).route, 'changes');
  run('deliver', {}, /REQUEST_CHANGES/);
  run('review-decision', { DECISION: '{"choice":"repair","note":"修复入口"}' });
  assert.match(state().failure, /缺少入口的重试约定[\s\S]*修复入口/);
  checkoutCandidate();
  const repair = head => ({ AGENT_REPLY: JSON.stringify({ head }) });
  writeFileSync(join(work, '.dickda/lints/healthy.sh'), 'exit 0\n');
  run('repair', repair(commit(work, 'weaken lint after review')), /仅更新 L4.*lints\/healthy\.sh/);
  assert.equal(git(origin, 'rev-parse', branch), first);
  checkoutCandidate();
  writeFileSync(join(work, entryDoc), '# 可重试入口\n');
  const repaired = commit(work, 'document retry contract');
  assert.equal(run('repair', repair(repaired)).head, repaired);
  const next = run('prepare-review');
  const previous = JSON.parse(next.previous);
  assert.deepEqual(previous, [{ ...finding, id: `${first.slice(0, 12)}-1` }]);
  assert.equal(next.base, first);
  assert.equal(next.head, repaired);
  const report = '复评要求补充重试条件';
  assert.equal(review(repaired, 'REQUEST_CHANGES', {
    report, findings: '[]', resolutions: JSON.stringify([{ id: previous[0].id, status: 'upheld', reason: report }]),
  }, next.previous).route, 'changes');
  assert.deepEqual(state().openReviewFindings, previous);
  run('review-decision', { DECISION: '{"choice":"kept","note":"  "}' }, /客观依据/);
  const reason = '通用经验条文已经覆盖本次入口的重试条件。';
  run('review-decision', { DECISION: JSON.stringify({ choice: 'kept', note: reason }) });
  const pr = run('deliver');
  assert.equal(pr.summary, readFileSync(join(artifacts, 'refine-pr.md'), 'utf8'));
  assert.equal(run('approval-check').summary, pr.summary);
  for (const item of [archive, 'L4', repaired, 'L2 Lints', report, 'REQUEST_CHANGES', reason]) assert.ok(pr.summary.includes(item), item);
  for (const [env, error] of [
    [{ PR_VIEW: '{"state":"CLOSED"}' }, /PR 已关闭/],
    [{ PR_VIEW: JSON.stringify({ headRefOid: original }) }, /提交已改变/],
    [{ PR_VIEW: '{"baseRefName":"other"}' }, /Default Branch/],
    [{ DEFAULT_BRANCH: 'trunk' }, /Default Branch/],
  ]) {
    run('approval-check', env, error);
    run('merge', env, error);
  }
  assert.equal(git(origin, 'rev-parse', 'main'), original);
  assert.equal(git(origin, 'rev-parse', branch), repaired);

  git(work, 'checkout', 'main');
  writeFileSync(join(work, 'app.mjs'), 'export const answer = () => 44;\n');
  writeFileSync(join(work, entryDoc), '# 入口响应\n');
  const upstreamArchive = '.dickda/learning/2000-01-01-00-00-00';
  mkdirSync(join(work, upstreamArchive));
  writeFileSync(join(work, upstreamArchive, 'old.md'), 'Already consumed upstream\n');
  writeFileSync(join(work, CONSUMED_FILE), `${upstreamArchive}\n`);
  const upstream = commit(work, 'upstream documents entry and updates code');
  git(work, 'push', 'origin', 'main');
  assert.equal(run('merge').route, 'conflict');
  assert.ok(git(origin, 'ls-tree', 'main', '--', archive));
  checkoutCandidate();
  writeFileSync(join(work, 'unrelated'), 'does not resolve the conflict');
  run('repair', repair(commit(work, 'unsynced descendant')), /尚未合入Default Branch/);
  assert.equal(git(origin, 'rev-parse', branch), repaired);
  run('continue-repair', { NOTE: '合入最新 main 并保留重试约定' });
  checkoutCandidate();
  git(work, 'merge', '-s', 'ours', '-m', 'silently drop upstream changes', upstream);
  run('repair', repair(git(work, 'rev-parse', 'HEAD')), /仅更新 L4.*app\.mjs/);
  assert.equal(git(origin, 'rev-parse', branch), repaired);
  checkoutCandidate();
  assert.throws(() => git(work, 'merge', '--no-commit', upstream), /Command failed/);
  assert.deepEqual(git(work, 'diff', '--name-only', '--diff-filter=U').split('\n'), [entryDoc, CONSUMED_FILE]);
  writeFileSync(join(work, entryDoc), '# 入口响应与重试约定\n');
  const combined = [archive, upstreamArchive].sort().join('\n');
  writeFileSync(join(work, CONSUMED_FILE), `${combined}\n`);
  git(work, 'add', entryDoc, CONSUMED_FILE);
  git(work, 'commit', '-m', 'resolve documentation conflict');
  const resolved = git(work, 'rev-parse', 'HEAD');
  for (const kept of [archive, upstreamArchive]) {
    writeFileSync(join(work, CONSUMED_FILE), `${kept}\n`);
    run('repair', repair(commit(work, 'drop one side of the consumption record')), /保留历史消费记录/);
    assert.equal(git(origin, 'rev-parse', branch), repaired);
  }
  run('continue-repair', { NOTE: '保留两个分支的消费记录' });
  git(work, 'checkout', '--detach', resolved);
  git(work, 'restore', '--source', upstream, '--', entryDoc, '.dickda/learning/Learning_General.md');
  run('repair', repair(commit(work, 'retain only upstream content and archive deletion')), /没有产生实质文件变更/);
  assert.equal(git(origin, 'rev-parse', branch), repaired);
  run('continue-repair', { NOTE: '保留提纯条文并同步入口文档' });
  const cleaned = run('repair', repair(resolved)).head;
  assert.equal(git(origin, 'rev-parse', `${cleaned}^`), resolved);
  assert.equal(git(origin, 'ls-tree', cleaned, '--', upstreamArchive), '');
  checkoutCandidate();
  writeFileSync(join(work, entryDoc), '# 入口响应\n\n失败后可重试。\n');
  const finalHead = commit(work, 'clarify retry after syncing main');
  assert.equal(run('repair', repair(finalHead)).head, finalHead);
  run('deliver', {}, /不一致/);
  const last = run('prepare-review', { RUNS: '[{"workflow":"check","state":"succeeded","runId":"check-3"}]' });
  assert.equal(last.head, finalHead);
  assert.equal(review(finalHead, 'APPROVE', { resolutions: JSON.stringify([{ id: previous[0].id, status: 'resolved' }]) }, last.previous).route, 'pr');
  const updated = run('deliver');
  assert.equal(updated.pr, pr.pr);
  assert.match(updated.summary, /check-3/);
  assert.match(updated.summary, /Independent Code Review · APPROVE/);
  assert.ok(updated.summary.includes(`${repaired}（REQUEST_CHANGES）：${reason}`));
  assert.equal(run('approval-check').summary, updated.summary);
  const merged = run('merge');
  assert.deepEqual(merged, { route: 'merged', commit: git(origin, 'rev-parse', 'main') });
  assert.notEqual(merged.commit, finalHead);
  assert.deepEqual(run('merge'), merged);
  assert.equal(git(origin, 'ls-tree', 'main', '--', archive), '');
  assert.equal(git(origin, 'show', `main:${CONSUMED_FILE}`), combined);
  assert.equal(git(origin, 'show', 'main:app.mjs'), git(origin, 'show', `${upstream}:app.mjs`));
  assert.match(git(origin, 'show', `main:${entryDoc}`), /失败后可重试/);
  assert.match(git(origin, 'show', 'main:.dickda/learning/Learning_General.md'), /入口须可重试/);
  assert.equal(git(origin, 'branch', '--list', branch), '');
  const calls = readFileSync(ghCallsFile, 'utf8').trim().split('\n').map(JSON.parse).filter(call => call.args[0] === 'pr');
  assert.ok(calls.every(call => call.thread === null));
  assert.equal(calls.filter(call => call.args[1] === 'create').length, 1);
  assert.ok(calls.some(call => call.args[1] === 'edit' && call.args.includes('--body-file')));
  assert.deepEqual(calls.filter(call => call.args[1] === 'merge').map(call => call.args.slice(-4)),
    [repaired, finalHead].map(head => ['--squash', '--match-head-commit', head, '--delete-branch']));
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
  assert.match(html, /Five-Layer Dashboard/);
  for (const title of ['L1 · Codebase', 'L2 · Static Analysis', 'L3 · Verification', 'L4 · Work Graph &amp; Prose', 'L5 · Human Review']) assert.ok(html.includes(title), title);
  assert.match(html, /window\.coda\.submit/);
  assert.ok(Buffer.byteLength(html, 'utf8') < 20 * 1024 * 1024);
});


test('antigravity mode is full for defaults, custom settings, workflow overrides and agent arguments', () => {
  const properties = JSON.parse(readFileSync(join(pluginDir, 'package.json'))).contributes.configuration.properties;
  const slots = ['interactor', 'thinker', 'lead', 'architectStandard', 'architectSenior'];
  for (const slot of slots) {
    assert.equal(properties[`dickda.${slot}`].default.mode, 'full');
    assert.equal(DEFAULT_SETTINGS[`dickda.${slot}`].mode, 'full');
  }
  for (const mode of [undefined, 'auto', 'default', 'full']) {
    const spec = { agent: ' antigravity ', model: 'custom', effort: 'high', options: { flag: 'value' }, ...(mode ? { mode } : {}) };
    const expected = { ...spec, agent: 'antigravity', mode: 'full' };
    assert.deepEqual(loadSettings(JSON.stringify({ 'dickda.thinker': spec })).thinker, expected);
    for (const [env, role, tier] of [['THINKER', 'thinker'], ['LEAD', 'lead'], ['ARCHITECT', 'architect', 'standard'], ['ARCHITECT_SENIOR', 'architect', 'senior'], ['BUILDER', 'builder', 'standard'], ['VERIFIER', 'verifier', 'standard'], ['VERIFIER_SENIOR', 'verifier', 'senior']]) {
      const settings = effectiveSettings({ [env]: JSON.stringify(spec) });
      assert.deepEqual(tier ? settings[role][tier] : settings[role], expected);
    }
    const args = agentArgs(spec);
    assert.equal(args[args.indexOf('--mode') + 1], 'full');
    assert.ok(args.includes('flag=value'));
  }
  for (const mode of [undefined, 'auto', 'default']) {
    const spec = { agent: 'codex', ...(mode ? { mode } : {}) };
    assert.deepEqual(loadSettings({ 'dickda.thinker': spec }).thinker, spec);
    const args = agentArgs(spec);
    assert.equal(args.includes('--mode'), !!mode);
    assert.ok(!args.includes('full'));
  }
});

for (const args of [['--help'], ['-h'], ['role', '--help'], ['help']]) {
  test(`CLI ${args.join(' ')} works outside a project before loading settings`, t => {
    const cwd = mkdtempSync(join(tmpdir(), 'dickda-help-'));
    t.after(() => rmSync(cwd, { recursive: true, force: true }));
    const result = spawnSync(process.execPath, [cliScript, ...args], {
      cwd, encoding: 'utf8', env: { ...process.env, CODA_PLUGIN_SETTINGS: '{invalid' },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /dickda init[\s\S]*dickda role[\s\S]*dickda verify/);
  });
}


test('antigravity Lead starts with full mode and continues without a mode argument', t => {
  const { dir, run, seedFast, lead } = workflowFixture(t);
  run('lane', { GOAL: '验证续跑参数' });
  seedFast();
  lead({ action: 'verify' });
  const first = JSON.parse(readFileSync(join(dir, 'agent-args.json')));
  assert.equal(first[first.indexOf('--mode') + 1], 'full');
  lead({ action: 'verify' });
  const continued = JSON.parse(readFileSync(join(dir, 'agent-args.json')));
  assert.ok(continued.includes('--continue'));
  assert.ok(!continued.includes('--mode'));
});


test('workflow XML escapes ampersands and role copy remains independent of default models', () => {
  for (const name of ['dickda', 'dickda-refine', 'dickda-verify']) {
    const { xml } = workflowGraph(name);
    const markup = xml.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '').replace(/<!--[\s\S]*?-->/g, '');
    assert.doesNotMatch(markup, /&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[\da-fA-F]+);)/, name);
    assert.doesNotMatch(xml, /(?:Interactor|Thinker|Lead)\s*(?:（(?:Neon|Carbon|Astra|Sol)）|(?:Neon|Carbon|Astra|Sol)\b)/, name);
    assert.doesNotMatch(xml, /Track道|Order单|结果导向/, name);
  }
  for (const file of ['README.md', 'skills/dickda/SKILL.md']) {
    const doc = readFileSync(join(pluginDir, file), 'utf8');
    for (const role of ['Lead', 'Architect', 'Builder', 'Verifier']) assert.ok(doc.includes(`Executors · ${role}`), `${file}: ${role}`);
    assert.doesNotMatch(doc, /执行 ·|SeniorVerifier|Track道|Order单/);
  }
  for (const file of ['prompts/roles/verifier.md', 'scripts/develop.mjs']) {
    const text = readFileSync(join(pluginDir, file), 'utf8');
    assert.ok(text.includes('Outcome-Oriented Verification'), file);
    assert.doesNotMatch(text, /结果导向/, file);
  }
});
