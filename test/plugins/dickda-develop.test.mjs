import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { backups, checkSpecLock, consumeBackup, layerHealth, remember, runLints } from '../../plugins/dickda-develop/scripts/assets.mjs';
import { writeDashboard } from '../../plugins/dickda-develop/scripts/dashboard.mjs';
import { enrichDispatchBatch, integrateWorkerResults } from '../../plugins/dickda-develop/scripts/develop.mjs';
import { panel, readPanel } from '../../plugins/dickda-develop/scripts/panel.mjs';
import { builtinPrompts, enablePrompt, promptTemplate, prompts, putPrompt, renderPrompt } from '../../plugins/dickda-develop/scripts/prompts.mjs';
import { applyProseRefinements, buildRefineContext, normalizeDiagnosis } from '../../plugins/dickda-develop/scripts/refine.mjs';
import { ROLES, loadSettings, resolveEngineer, rolePrompt } from '../../plugins/dickda-develop/scripts/roles.mjs';
import { init, inside, runtime } from '../../plugins/dickda-develop/scripts/store.mjs';
import { runAgentVerifiers, runCodeVerifiers } from '../../plugins/dickda-develop/scripts/verify.mjs';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const pluginDir = join(repoRoot, 'plugins/dickda-develop');
const cliScript = join(pluginDir, 'scripts/cli.mjs');
const developScript = join(pluginDir, 'scripts/develop.mjs');

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

test('three roles and four trades default to exact requested models and escalate to senior on difficulty or rejections', () => {
  const settings = loadSettings('{}');
  assert.deepEqual(settings.interactor, { agent: 'antigravity', model: 'gemini-4-neon', effort: 'xhigh' });
  assert.deepEqual(settings.thinker, { agent: 'antigravity', model: 'gemini-4-carbon', effort: 'high' });
  assert.deepEqual(settings.lead, { agent: 'antigravity', model: 'gemini-4-neon', effort: 'xhigh' });

  // Architect standard MUST be Antigravity claude-opus-5-5 (high), senior MUST be carbon-high
  const archStd = resolveEngineer('architect', { difficulty: 'normal', rejections: 0 }, settings);
  assert.equal(archStd.tier, 'standard');
  assert.equal(archStd.escalated, false);
  assert.deepEqual(archStd.agent, { agent: 'antigravity', model: 'claude-opus-5-5', effort: 'high' });

  const archHard = resolveEngineer('architect', { difficulty: 'hard', rejections: 0 }, settings);
  assert.equal(archHard.tier, 'senior');
  assert.equal(archHard.escalated, true);
  assert.deepEqual(archHard.agent, { agent: 'antigravity', model: 'gemini-4-carbon', effort: 'high' });

  // Builder: astra-high -> astra-max after reaching rejection threshold (default 2)
  const buildOnce = resolveEngineer('builder', { rejections: 1 }, settings);
  assert.equal(buildOnce.tier, 'standard');
  assert.deepEqual(buildOnce.agent, { agent: 'codex', model: 'gpt-6.2-astra', effort: 'high' });

  const buildEscalated = resolveEngineer('builder', { rejections: 2 }, settings);
  assert.equal(buildEscalated.tier, 'senior');
  assert.equal(buildEscalated.escalated, true);
  assert.deepEqual(buildEscalated.agent, { agent: 'codex', model: 'gpt-6.2-astra', effort: 'max' });

  // Verifier: sol-high -> sol-max when explicitly requested or escalated
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

  // Runtime directory lives inside .git/dickda, not inside tracked worktree files
  const runtimeMarker = runtime(work, 'runs/active.json');
  writeFileSync(runtimeMarker, '{"active":true}\n');
  commit(work, 'commit unified .dickda assets');
  const cloned = join(dir, 'cloned');
  git(dir, 'clone', '-q', work, cloned);
  assert.ok(!existsSync(runtime(cloned, 'runs/active.json')));

  // Symlink escape inside .dickda is rejected
  symlinkSync('/tmp', join(work, '.dickda/escape-link'));
  assert.throws(() => inside(work, '.dickda/escape-link/secret'), /符号链接/);
  rmSync(join(work, '.dickda/escape-link'));
});

test('L2 executable lints, spec-lock enforcement, and L3 dual-track verifiers work end-to-end', t => {
  const { work, commit } = createGitRepo(t);
  init(work);

  // Add an L2 Executable Spec lint forbidding TODO_FORBIDDEN
  writeFileSync(join(work, '.dickda/lints/no-forbidden.mjs'), [
    '// Forbid TODO_FORBIDDEN marker in source files',
    'import { readFileSync } from "node:fs";',
    'import { join } from "node:path";',
    'const text = readFileSync(join(process.env.DICKDA_ROOT, "app.mjs"), "utf8");',
    'if (text.includes("TODO_FORBIDDEN")) { console.error("Found forbidden marker"); process.exit(1); }',
  ].join('\n'));
  writeFileSync(join(work, '.dickda/verifiers/check-answer.mjs'), [
    'import assert from "node:assert/strict";',
    'import { pathToFileURL } from "node:url";',
    'import { join } from "node:path";',
    'const mod = await import(pathToFileURL(join(process.env.DICKDA_ROOT, "app.mjs")).href);',
    'assert.equal(mod.answer(), 42);',
  ].join('\n'));
  writeFileSync(join(work, '.dickda/verifiers/ui-console.md'), '# UI Console Smoke\n1. Open main view and verify title renders.\n');
  const baseHead = commit(work, 'lock L2 lint and L3 verifiers');

  assert.equal(runLints(work).passed, true);
  assert.equal(runCodeVerifiers(work).passed, true);

  // Violating L2 lint fails deterministically
  writeFileSync(join(work, 'app.mjs'), 'export const answer = () => 42; // TODO_FORBIDDEN\n');
  assert.equal(runLints(work).passed, false);
  writeFileSync(join(work, 'app.mjs'), 'export const answer = () => 42;\n');

  // Spec lock catches builder tampering with .dickda/lints/
  writeFileSync(join(work, '.dickda/lints/no-forbidden.mjs'), '// weakened\n');
  const badHead = commit(work, 'builder tampered with lint');
  const lockCheck = checkSpecLock(work, baseHead, badHead);
  assert.equal(lockCheck.ok, false);
  assert.deepEqual(lockCheck.violations, ['.dickda/lints/no-forbidden.mjs']);

  // L3 Agent/UI verifier track passes Sol flags and parses structured JSON verdict
  let capturedArgs = null;
  const agentOutcome = runAgentVerifiers(work, {
    difficulty: 'hard',
    runner: args => {
      capturedArgs = args;
      return {
        status: 0,
        stdout: JSON.stringify({
          session: 'sol-session-1',
          answer: 'UI check complete.\n```json\n{"passed": true, "summary": "UI verified", "evidence": ["/tmp/shot.png"], "findings": []}\n```',
        }),
      };
    },
  });
  assert.equal(agentOutcome.passed, true);
  assert.equal(agentOutcome.tier, 'senior');
  assert.ok(capturedArgs.includes('gpt-6.1-sol') && capturedArgs.includes('max'));
  assert.deepEqual(agentOutcome.evidence, ['/tmp/shot.png']);
});

test('concurrent multi-trade dispatch integrates non-conflicting commits and escalates conflicting/rejected jobs', t => {
  const { work, git, commit } = createGitRepo(t);
  init(work);
  const baseTip = commit(work, 'base state');

  // Branch 1: architect adds .dickda/lints/arch.mjs
  git(work, 'checkout', '-b', 'job-arch', baseTip);
  writeFileSync(join(work, '.dickda/lints/arch.mjs'), '// arch lint\nprocess.exit(0);\n');
  const archHead = commit(work, 'arch spec');

  // Branch 2: builder-a adds module-a.mjs cleanly
  git(work, 'checkout', '-b', 'job-a', baseTip);
  writeFileSync(join(work, 'module-a.mjs'), 'export const a = 1;\n');
  const headA = commit(work, 'impl module a');

  // Branch 3: builder-b edits app.mjs
  git(work, 'checkout', '-b', 'job-b1', baseTip);
  writeFileSync(join(work, 'app.mjs'), 'export const answer = () => 100;\n');
  const headB1 = commit(work, 'impl b1');

  // Branch 4: builder-conflict also edits app.mjs incompatibly
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
    { ...batch[4], status: 'succeeded', summary: 'Checked', findings: [{ level: 'nit', title: 'Minor naming', detail: 'ok' }] },
  ], ledger);

  assert.equal(integrated.changed, true);
  assert.equal(integrated.landed.length, 3);
  assert.equal(integrated.rejected.length, 1);
  assert.equal(integrated.rejected[0].id, 'impl-conflict');
  assert.equal(integrated.rejected[0].rejections, 2);
  assert.equal(integrated.rejected[0].nextTier, 'senior');
  assert.equal(integrated.findings.length, 1);

  // Re-dispatching impl-conflict now automatically escalates to senior (astra-max)
  const nextWave = enrichDispatchBatch([
    { id: 'impl-conflict', trade: 'builder', title: 'Retry conflicting app edit', task: 'retry' },
  ], integrated.ledger);
  assert.equal(nextWave[0].tier, 'senior');
  assert.equal(nextWave[0].escalated, true);
  assert.equal(nextWave[0].agent.effort, 'max');
});

test('full dickda-develop script lifecycle runs private PR delivery without leaking CODA_THREAD_ID', t => {
  const { dir, work, env } = createGitRepo(t);

  // Stub gh and coda-agent in PATH
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
  console.log(JSON.stringify({ state: fs.existsSync(dir + '/merged') ? 'MERGED' : 'OPEN', headRefOid: state.head, baseRefName: 'main', mergeable: 'MERGEABLE', mergeCommit: { oid: 'a'.repeat(40) } }));
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

  const runStep = (step, extra = {}) => {
    writeFileSync(env.GITHUB_OUTPUT, '');
    const res = spawnSync(process.execPath, [developScript, step], { cwd: work, env: { ...env, ...extra }, encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    return Object.fromEntries(
      [...readFileSync(env.GITHUB_OUTPUT, 'utf8').matchAll(/(\w+)<<([^\n]+)\n([\s\S]*?)\n\2\n/g)]
        .map(([, k, , v]) => [k, v])
    );
  };

  const lane = runStep('lane', { TITLE: 'Demo Feature', GOAL: 'Implement demo feature cleanly' });
  assert.equal(lane.needBrief, 'false');
  runStep('seed');
  runStep('think');

  const wave1 = runStep('lead-plan');
  assert.equal(wave1.route, 'dispatch');
  assert.equal(wave1.jobIds, 'impl-1');

  runStep('worker', { JOB_ID: 'impl-1' });
  const integrated = runStep('integrate');
  assert.equal(integrated.changed, 'true');

  const wave2 = runStep('lead-plan');
  assert.equal(wave2.route, 'verify');

  const prep = runStep('prepare-verify');
  assert.match(prep.reviewer, /gpt-6\.1-sol/);
  const ver = runStep('verified', { VERIFY_PASSED: 'true', VERIFY_REPORT: '双轨全绿', REVIEW: JSON.stringify({ decision: 'APPROVE', line: 'LGTM', report: 'Clean' }) });
  assert.equal(ver.route, 'pr');

  const pr = runStep('pr', { DEVICES: 'false' });
  assert.equal(pr.url, 'https://github.com/fixture/dickda-demo/pull/7');
  assert.match(pr.summary, /非阻塞样式建议/);

  runStep('approval-check');
  const merged = runStep('merge');
  assert.equal(merged.route, 'merged');

  const ghCalls = readFileSync(ghCallsFile, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.ok(ghCalls.filter(c => c.args[0] === 'pr').every(c => c.thread === null), 'PR operations must strip CODA_THREAD_ID');
});

test('refine flywheel, custom prompts, sidebar panel, and interactive HTML dashboard work cohesively', t => {
  const { work, env, dir } = createGitRepo(t);
  process.env.CODA_PLUGIN_STATE = env.CODA_PLUGIN_STATE;
  init(work);

  // Builtin and custom prompts
  assert.deepEqual(builtinPrompts().map(p => p.id), ['general', 'cpp']);
  const tpl = promptTemplate('team-arch');
  putPrompt(work, tpl);
  enablePrompt(work, 'team-arch', true);
  assert.ok(prompts(work).find(p => p.id === 'team-arch')?.enabled);
  assert.match(renderPrompt(builtinPrompts()[0], 'correctness'), /crash early/i);

  // Archive & Refine prose slimming
  writeFileSync(join(work, '.dickda/learning/Learning_General.md'), '# !!!LEARNING!!!\n- 旧口头规则：手动检查格式 [2]\n');
  writeFileSync(join(work, '.dickda/tasks/logs/investigate.md'), '# Session Log\nRepeated lint issue found.\n');
  const archived = remember(work, new Date('2026-11-24T12:00:00Z'));
  assert.equal(archived.archived, true);
  assert.equal(backups(work, 5).length, 1);

  const refineCtx = buildRefineContext(work);
  assert.equal(refineCtx.hasArchive, true);
  const diag = normalizeDiagnosis({
    needsRefactor: true,
    layers: ['L2', 'L4'],
    summary: 'Promote formatting rule to L2 lint',
    obsoleteProse: ['旧口头规则：手动检查格式'],
    learningUpdates: ['所有架构红线优先写入 .dickda/lints'],
  });
  applyProseRefinements(work, diag);
  consumeBackup(work, refineCtx.archive);
  const updatedLearning = readFileSync(join(work, '.dickda/learning/Learning_General.md'), 'utf8');
  assert.doesNotMatch(updatedLearning, /旧口头规则/);
  assert.match(updatedLearning, /所有架构红线优先写入 \.dickda\/lints \[1\]/);
  assert.equal(layerHealth(work).pendingArchives, 0);

  // Panel overview, roles view, and stale view fallback
  const overview = panel(env.CODA_PLUGIN_STATE, { view: 'overview' });
  assert.ok(overview.items.some(c => c.title.includes('跨项目五层健康度')));
  const rolesView = panel(env.CODA_PLUGIN_STATE, { view: 'roles' });
  assert.match(JSON.stringify(rolesView), /claude-opus-5-5/);
  writeFileSync(join(env.CODA_PLUGIN_STATE, 'view.json'), JSON.stringify({ view: 'project', key: '0'.repeat(64), kind: 'lints' }));
  const recovered = readPanel(env.CODA_PLUGIN_STATE);
  assert.ok(recovered.items.length >= 2);

  // CLI & Dashboard HTML generation
  const htmlPath = join(dir, 'console.html');
  const cliOut = execFileSync(process.execPath, [cliScript, 'dashboard', '--root', work, '--output', htmlPath], { env, encoding: 'utf8' });
  const parsedCli = JSON.parse(cliOut);
  assert.equal(parsedCli.path, htmlPath);
  const html = readFileSync(htmlPath, 'utf8');
  assert.match(html, /五层工程控制台/);
  assert.match(html, /window\.coda\.submit/);
  assert.ok(Buffer.byteLength(html, 'utf8') < 20 * 1024 * 1024);
});
