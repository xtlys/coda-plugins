// Delivery owned by vczh-develop. The investigation itself stays in the native
// Markdown documents; only this run's delivery bookkeeping lives in artifacts.
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config, hash, init, inside } from './store.mjs';

const env = process.env;
const stateFile = join(env.CODA_ARTIFACTS, 'vczh-develop.json');
const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : null;
const json = (name, fallback = null) => env[name] ? JSON.parse(env[name]) : fallback;
const save = value => writeFileSync(stateFile, `${JSON.stringify(value, null, 2)}\n`);
const output = (name, value) => {
  const delimiter = randomUUID();
  appendFileSync(env.GITHUB_OUTPUT, `${name}<<${delimiter}\n${typeof value === 'object' ? JSON.stringify(value) : value ?? ''}\n${delimiter}\n`);
};
const outputs = values => Object.entries(values).forEach(([key, value]) => output(key, value));
const command = (bin, args, options = {}) => execFileSync(bin, args, {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], ...options,
}).trim();
const git = (...args) => command('git', args);
const gh = (...args) => command('gh', args);
const ensure = (ok, message) => { if (!ok) throw new Error(message); };
const privateGh = (...args) => {
  // Same boundary as composer's openPr: no session means no PR report, watcher,
  // or independent pull-request lifecycle. Do not turn off global PR settings.
  const { CODA_THREAD_ID: _thread, ...privateEnv } = env;
  return command('gh', args, { env: privateEnv });
};
const feedback = text => { save({ ...state, feedback: text }); output('text', text); };
const headOf = branch => git('rev-parse', '--verify', `refs/heads/${branch}^{commit}`);
const runLines = (record, head) => record?.head === head
  ? record.runs.map(r => `${r.workflow}: ${r.state} coda://workflow-runs/${r.runId}`).join('\n') || '项目未声明此类检查。'
  : '本提交尚未完成检查。';
const summary = value => [value.report,
  `提交：${value.head}`,
  `项目检查：\n${runLines(value.checks, value.head)}`,
  value.review?.head === value.head ? `代码评审：${value.review.line}\n${value.review.report}` : '',
  value.kept ? `未采纳意见与理由：\n${value.kept}` : '',
  value.acceptedHead === value.head ? `验收通过：${value.acceptance ?? ''}` : '',
].filter(Boolean).join('\n\n');
const taskText = () => readFileSync(inside(state.root, 'TODO_TASK.md'), 'utf8');

switch (process.argv[2]) {
  case 'lane': {
    if (state) { outputs(state); break; }
    const dependencies = json('CODA_PLUGIN_DEPENDENCIES', {});
    if (dependencies.review) ensure(existsSync(join(dependencies.review, '.coda/capabilities/review-commit.bpmn')),
      '请先将官方 review 插件更新到 2.17.0 或更新版本，以提供 review-commit 能力');
    const info = JSON.parse(gh('repo', 'view', '--json', 'nameWithOwner,defaultBranchRef'));
    const base = info.defaultBranchRef.name;
    const remote = `https://github.com/${info.nameWithOwner}.git`;
    git('fetch', '--quiet', remote, base);
    const baseCommit = git('rev-parse', 'FETCH_HEAD');
    let start = baseCommit;
    if (env.BRANCH && env.BRANCH !== base) start = headOf(env.BRANCH);
    const branch = `agent/vczh-${env.GITHUB_RUN_ID}`;
    const root = join(env.CODA_PLUGIN_STATE, 'worktrees', env.GITHUB_RUN_ID);
    mkdirSync(join(env.CODA_PLUGIN_STATE, 'worktrees'), { recursive: true });
    // A private author branch protects uncommitted user work and gives experiments
    // a baseline they may safely revert. It has no PR observer of its own.
    if (!existsSync(root)) git('worktree', 'add', '-b', branch, root, start);
    ensure(git('-C', root, 'branch', '--show-current') === branch, '调查工作树的分支与运行不一致');
    const group = `vczh:${existsSync(join(root, '.github/vczh/project.json'))
      ? config(root).projectId : hash(realpathSync(git('rev-parse', '--path-format=absolute', '--git-common-dir')))}`;
    const value = { root: realpathSync(root), branch, base, baseCommit, remote,
      lane: `vczh/${env.GITHUB_RUN_ID}`, group, head: '', pr: '', acceptedHead: '' };
    save(value); outputs(value); break;
  }
  case 'initialize':
    ensure(env.GROUP === state.group, '尚未取得本项目的独占组');
    init(state.root);
    break;
  case 'push': {
    const head = headOf(state.branch);
    git('fetch', '--quiet', state.remote, state.base);
    const baseCommit = git('rev-parse', 'FETCH_HEAD');
    if (git('rev-list', '--count', `${baseCommit}..${head}`) === '0' || head === state.head) {
      feedback(`分支 ${state.branch} 没有新的交付提交。请完成调查、提交实现与 Markdown 文档后再答复。`);
      output('route', 'fix'); break;
    }
    // Read before pushing: a missing task document must not become a published PR.
    const task = taskText();
    ensure(task.trim(), 'TODO_TASK.md 不能为空');
    const report = json('REPORT', {}).note?.trim() || state.report;
    ensure(report, '请提供改动汇报');
    git('push', '--quiet', '--force', '--no-follow-tags', state.remote, `${head}:refs/heads/${state.lane}`);
    const next = { ...state, head, baseCommit, report, task, kept: '', feedback: '' };
    save(next); outputs({ head, baseCommit, route: 'checks' }); break;
  }
  case 'checks': {
    const result = json('RESULT', {});
    save({ ...state, checks: { head: state.head, runs: result.runs ?? [] } });
    break;
  }
  case 'pr': {
    const body = join(env.CODA_ARTIFACTS, 'pull-request.md');
    writeFileSync(body, summary(state));
    let pr = state.pr;
    if (pr) privateGh('pr', 'edit', pr, '--body-file', body);
    else {
      // Recover a successful creation if a process died before saving the URL.
      const existing = JSON.parse(privateGh('pr', 'list', '--repo', state.remote,
        '--head', state.lane, '--base', state.base, '--state', 'open', '--json', 'url'));
      pr = existing[0]?.url || privateGh('pr', 'create', '--repo', state.remote,
        '--base', state.base, '--head', state.lane,
        '--title', git('log', '--format=%s', '-1', state.head), '--body-file', body);
    }
    save({ ...state, pr });
    outputs({ url: pr, head: state.head, base: state.baseCommit, task: state.task,
      evidence: runLines(state.checks, state.head), summary: summary(state),
      review: state.review?.head !== state.head,
      device: env.DEVICES === 'true' && state.acceptedHead !== state.head });
    break;
  }
  case 'reviewed': {
    const review = json('REVIEW');
    ensure(review?.head === state.head, '评审结果不属于当前交付提交');
    save({ ...state, review });
    outputs({ changes: review.decision === 'REQUEST_CHANGES', incomplete: review.decision === 'INCOMPLETE' });
    break;
  }
  case 'kept': {
    const note = json('ANSWER', {}).note?.trim();
    ensure(note, '不采纳评审意见时必须说明理由');
    save({ ...state, kept: note }); break;
  }
  case 'failed':
    feedback(`${env.STEP}没有通过。当前提交 ${state.head}；运行 coda://workflow-runs/${env.GITHUB_RUN_ID}。\n用 workflow_status 读取失败步骤、子流程及日志；把实际原因按 # Continue 追加到调查，修复后重新提交。${env.LINES ? `\n${env.LINES}` : ''}`);
    break;
  case 'problem': output('text', state.feedback); break;
  case 'accepted': {
    if (env.ROUTE === 'changed') { output('route', 'push'); break; }
    const reply = json('DEVICE', {});
    if (env.ROUTE === 'failed') {
      feedback(`验收未通过（${state.head}）：\n${reply.note ?? ''}\n${(reply.attachments ?? []).map(path => `附件：${path}`).join('\n')}`);
      output('route', 'fix'); break;
    }
    save({ ...state, acceptedHead: state.head, acceptance: reply.note || '用户已确认' });
    output('route', 'premerge'); break;
  }
  case 'approval': {
    const premerge = json('PREMERGE', {});
    const live = JSON.parse(privateGh('pr', 'view', state.pr, '--json', 'headRefOid,baseRefName,state'));
    const main = gh('repo', 'view', state.remote, '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name');
    ensure(live.state === 'OPEN' && live.headRefOid === state.head, 'PR 已关闭或提交改变；不能批准未经检查的提交');
    ensure(live.baseRefName === main && main === state.base, '只能合并到仓库当前默认分支');
    outputs({ summary: summary(state), premerge: runLines({ head: state.head, runs: premerge.runs ?? [] }, state.head) });
    break;
  }
  case 'merge': {
    const live = JSON.parse(privateGh('pr', 'view', state.pr, '--json', 'state,headRefOid,baseRefName,mergeCommit'));
    ensure(live.headRefOid === state.head, '批准后 PR 提交已改变，不能合并');
    ensure(live.baseRefName === state.base && state.base === gh('repo', 'view', state.remote,
      '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name'), '只能合并到仓库当前默认分支');
    if (live.state === 'MERGED') { outputs({ route: 'merged', commit: live.mergeCommit.oid }); break; }
    ensure(live.state === 'OPEN', 'PR 已关闭但未合并');
    const method = env.METHOD;
    ensure(['merge', 'squash', 'rebase'].includes(method), '不支持的合并方式');
    const { CODA_THREAD_ID: _thread, ...privateEnv } = env;
    const done = spawnSync('gh', ['pr', 'merge', state.pr, '--repo', state.remote,
      `--${method}`, '--match-head-commit', state.head, '--delete-branch'], { encoding: 'utf8', env: privateEnv });
    if (done.error) throw done.error;
    process.stdout.write(done.stdout ?? ''); process.stderr.write(done.stderr ?? '');
    const now = JSON.parse(privateGh('pr', 'view', state.pr, '--json', 'state,mergeable,mergeCommit'));
    if (now.state === 'MERGED') outputs({ route: 'merged', commit: now.mergeCommit.oid });
    else if (now.state === 'OPEN' && now.mergeable === 'CONFLICTING') {
      feedback(`PR ${state.pr} 与 ${state.base} 冲突。按调查协议处理 rebase，代码变化后重测；提交到 ${state.branch} 后重新检查、评审和批准。`);
      output('route', 'conflict');
    } else throw new Error(`合并未完成：${now.state}；${done.stderr || done.stdout}`);
    break;
  }
  case 'options': {
    const reply = json('APPROVED', {}), chosen = reply.options ?? {};
    // Task choices expose selected option ids as a boolean map.
    const enabled = name => chosen[name] === true;
    const kinds = ['preview', 'release'].filter(enabled);
    outputs({ deploy: enabled('deploy'), release: kinds.length > 0, releaseKinds: kinds.join(','), notify: enabled('notify') });
    break;
  }
  case 'notes': {
    const note = json('AGENT', {}).note?.trim();
    ensure(note, '更新说明不能为空'); output('inputs', { notes: note, publish: 'true' }); break;
  }
  default: throw new Error('未知 vczh 开发步骤');
}
