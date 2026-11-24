import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { backups, checkSpecLock, consumeBackup, layerHealth, remember, runLints } from '../../plugins/dickda-develop/scripts/assets.mjs';
import { writeDashboard } from '../../plugins/dickda-develop/scripts/dashboard.mjs';
import { enrichDispatchBatch, evaluateVerificationGate, evaluateVerifierAnswer, integrateWorkerResults } from '../../plugins/dickda-develop/scripts/develop.mjs';
import { panel, readPanel } from '../../plugins/dickda-develop/scripts/panel.mjs';
import { builtinPrompts, enablePrompt, promptTemplate, prompts, putPrompt, renderPrompt } from '../../plugins/dickda-develop/scripts/prompts.mjs';
import { applyProseRefinements, buildRefineContext, executeRefinePlan, normalizeDiagnosis } from '../../plugins/dickda-develop/scripts/refine.mjs';
import { ROLES, loadSettings, resolveEngineer, rolePrompt } from '../../plugins/dickda-develop/scripts/roles.mjs';
import { init, inside, runtime } from '../../plugins/dickda-develop/scripts/store.mjs';
import { checkoutTargetCommit, runAgentVerifiers, runCodeVerifiers } from '../../plugins/dickda-develop/scripts/verify.mjs';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const pluginDir = join(repoRoot, 'plugins/dickda-develop');
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
  const stateDir = join(dir, 'plugin-state');
  const artifacts = join(dir, 'artifacts');
  for (const p of [work, stateDir, artifacts, join(dir, 'bin'), join(dir, 'tmp')]) mkdirSync(p, { recursive: true });

  const env = {
    ...process.env,
    CODA_PLUGIN_PATH: pluginDir,
    CODA_PLUGIN_STATE: stateDir,
    CODA_ARTIFACTS: artifacts,
    RUNNER_TEMP: join(dir, 'tmp'),
    GITHUB_OUTPUT: join(dir, 'github-output'),
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

  return { dir, work, origin, stateDir, artifacts, env, git, commit };
}

function parseOutputs(file) {
  return Object.fromEntries(
    [...readFileSync(file, 'utf8').matchAll(/(\w+)<<([^\n]+)\n([\s\S]*?)\n\2\n/g)]
      .map(([, k, , v]) => [k, v])
  );
}

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
  const { work, env, commit, git, dir } = createGitRepo(t);
  process.env.CODA_PLUGIN_STATE = env.CODA_PLUGIN_STATE;
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
  rmSync(join(work, '.dickda/escape-link'));
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

test('full dickda-develop lifecycle persists investigation archive onto delivery branch across ephemeral step worktrees', t => {
  const { dir, origin, env, git } = createGitRepo(t);

  const ghCallsFile = join(dir, 'gh-calls.jsonl');
  writeFileSync(ghCallsFile, '');
  const fakeGh = join(dir, 'bin/gh');
  writeFileSync(fakeGh, `#!${process.execPath}
const fs = require('node:fs');
const dir = process.env.FIXTURE_DIR;
const args = process.argv.slice(2);
fs.appendFileSync(dir + '/gh-calls.jsonl', JSON.stringify({ args, thread: process.env.CODA_THREAD_ID ?? null }) + '\\n');
const stateFile = process.env.CODA_ARTIFACTS + '/develop.json';
const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {};
if (args[0] === 'repo') {
  console.log(args.includes('--jq') ? 'main' : JSON.stringify({ nameWithOwner: 'fixture/dickda-demo', defaultBranchRef: { name: 'main' } }));
} else if (args[0] === 'pr' && args[1] === 'list') {
  console.log('[]');
} else if (args[0] === 'pr' && args[1] === 'create') {
  console.log('https://github.com/fixture/dickda-demo/pull/7');
} else if (args[0] === 'pr' && args[1] === 'view') {
  console.log(JSON.stringify({ state: fs.existsSync(dir + '/merged') ? 'MERGED' : 'OPEN', headRefOid: state.head, baseRefName: 'main', mergeable: 'MERGEABLE', mergeCommit: { oid: state.head } }));
} else if (args[0] === 'pr' && args[1] === 'merge') {
  fs.writeFileSync(dir + '/merged', '1');
}
`);
  chmodSync(fakeGh, 0o755);

  const fakeCodaAgent = join(dir, 'bin/coda-agent');
  writeFileSync(fakeCodaAgent, `#!${process.execPath}
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const args = process.argv.slice(2);
const promptFile = args[args.indexOf('--prompt-file') + 1];
const prompt = fs.readFileSync(promptFile, 'utf8');
const git = (...a) => execFileSync('git', a, { encoding: 'utf8' }).trim();

if (prompt.includes('思考者（Thinker）')) {
  fs.writeFileSync('.dickda/tasks/PLAN_5L.md', '# 五层技术方案\\n\\n## L1 · Codebase\\nClean API\\n');
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
  fs.writeFileSync('.dickda/tasks/logs/investigate.md', '# Investigation Log\\nConfirmed proposal A.\\n');
  git('add', 'feature.mjs', '.dickda/tasks/logs/investigate.md');
  git('commit', '-m', 'feat: implement feature');
  console.log(JSON.stringify({ session: 'worker-1', branch: 'b', head: git('rev-parse', 'HEAD'), answer: '交付说明\\n1. 已完成\\n2. node --test 通过' }));
}
`);
  chmodSync(fakeCodaAgent, 0o755);

  // Run EVERY step in its own fresh ephemeral clone of origin (at main, before .dickda existed!), matching Coda BPMN step semantics!
  let stepCounter = 0;
  const runIsolatedStep = (step, extra = {}, expected = 0) => {
    const stepDir = join(dir, `ephemeral-step-${++stepCounter}`);
    git(dir, 'clone', '-q', origin, stepDir);
    git(stepDir, 'config', 'user.name', 'Dickda Runner');
    git(stepDir, 'config', 'user.email', 'runner@example.com');
    writeFileSync(env.GITHUB_OUTPUT, '');
    const res = spawnSync(process.execPath, [developScript, step], { cwd: stepDir, env: { ...env, ...extra }, encoding: 'utf8' });
    rmSync(stepDir, { recursive: true, force: true });
    assert.equal(res.status, expected, res.stderr || res.stdout);
    return parseOutputs(env.GITHUB_OUTPUT);
  };

  const lane = runIsolatedStep('lane', { TITLE: 'Demo Feature', GOAL: 'Implement demo feature cleanly' });
  assert.equal(lane.needBrief, 'false');
  runIsolatedStep('seed');
  runIsolatedStep('think');

  const wave1 = runIsolatedStep('lead-plan');
  assert.equal(wave1.route, 'dispatch');
  runIsolatedStep('worker', { JOB_ID: 'impl-1' });
  const integrated = runIsolatedStep('integrate');
  assert.equal(integrated.changed, 'true');

  const wave2 = runIsolatedStep('lead-plan');
  assert.equal(wave2.route, 'verify');

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
  assert.equal(readFileSync(join(inspectDir, '.dickda/tasks/logs/investigate.md'), 'utf8').trim(), '# !!!DICKDA_INVESTIGATE!!!');

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
git('checkout', '--detach', '--force', commitSha);

if (prompt.includes('Refine 归档复盘输入')) {
  const diag = {
    needsRefactor: true,
    layers: ['L1', 'L2', 'L4'],
    summary: 'Add helper and L2 lint, remove obsolete prose',
    actions: [
      { layer: 'L1', trade: 'builder', title: 'Add helper', task: 'create helper.mjs' },
      { layer: 'L2', trade: 'architect', title: 'Add lint requiring helper', task: 'verify helper.mjs exists' },
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
  let stepNo = 0;
  const runRefineStep = (step, extra = {}) => {
    const stepDir = join(dir, `refine-step-${++stepNo}`);
    git(dir, 'clone', '-q', origin, stepDir);
    git(stepDir, 'config', 'user.name', 'Refine Runner');
    git(stepDir, 'config', 'user.email', 'refine@example.com');
    writeFileSync(env.GITHUB_OUTPUT, '');
    const res = spawnSync(process.execPath, [refineScript, step], {
      cwd: stepDir,
      env: { ...env, CODA_ARTIFACTS: refineArtifacts, GITHUB_RUN_ID: 'refine-202', ...extra },
      encoding: 'utf8',
    });
    rmSync(stepDir, { recursive: true, force: true });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    return parseOutputs(env.GITHUB_OUTPUT);
  };

  const collected = runRefineStep('collect');
  assert.equal(collected.hasArchive, 'true');
  assert.equal(collected.archive, archived.path);

  const diagnosed = runRefineStep('diagnose');
  assert.equal(diagnosed.needsRefactor, 'true');

  runRefineStep('decide', { DECISION: JSON.stringify({ choice: 'refactor', note: 'Proceed with L1+L2' }) });
  const executed = runRefineStep('execute');
  assert.ok(executed.head);

  const delivered = runRefineStep('deliver');
  assert.equal(delivered.pr, 'https://github.com/fixture/dickda-demo/pull/9');
  assert.equal(delivered.consumed, archived.path);

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

test('custom prompts, sidebar panel, and interactive HTML dashboard work cohesively', t => {
  const { work, env, dir } = createGitRepo(t);
  process.env.CODA_PLUGIN_STATE = env.CODA_PLUGIN_STATE;
  init(work);

  assert.deepEqual(builtinPrompts().map(p => p.id), ['general', 'cpp']);
  const tpl = promptTemplate('team-arch');
  putPrompt(work, tpl);
  enablePrompt(work, 'team-arch', true);
  assert.ok(prompts(work).find(p => p.id === 'team-arch')?.enabled);
  assert.match(renderPrompt(builtinPrompts()[0], 'correctness'), /crash early/i);

  const overview = panel(env.CODA_PLUGIN_STATE, { view: 'overview' });
  assert.ok(overview.items.some(c => c.title.includes('跨项目五层健康度')));
  const rolesView = panel(env.CODA_PLUGIN_STATE, { view: 'roles' });
  assert.match(JSON.stringify(rolesView), /claude-opus-5-5/);
  writeFileSync(join(env.CODA_PLUGIN_STATE, 'view.json'), JSON.stringify({ view: 'project', key: '0'.repeat(64), kind: 'lints' }));
  const recovered = readPanel(env.CODA_PLUGIN_STATE);
  assert.ok(recovered.items.length >= 2);

  const htmlPath = join(dir, 'console.html');
  const cliOut = execFileSync(process.execPath, [cliScript, 'dashboard', '--root', work, '--output', htmlPath], { env, encoding: 'utf8' });
  const parsedCli = JSON.parse(cliOut);
  assert.equal(parsedCli.path, htmlPath);
  const html = readFileSync(htmlPath, 'utf8');
  assert.match(html, /五层工程控制台/);
  assert.match(html, /window\.coda\.submit/);
  assert.ok(Buffer.byteLength(html, 'utf8') < 20 * 1024 * 1024);
});
