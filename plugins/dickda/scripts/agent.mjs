import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

export function callCodaAgent(args, cwd = process.cwd(), runner) {
  const res = runner ? runner(args) : spawnSync('coda-agent', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return parseAgentResult(res);
}

function parseAgentResult(res) {
  const stdout = res.stdout ?? '';
  const stderr = res.stderr ?? '';
  let parsed = null;
  let nonJson = stdout;
  for (const candidate of [stdout, ...stdout.trim().split('\n').reverse()]) {
    try {
      const value = JSON.parse(candidate);
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      parsed = value;
      nonJson = stdout.replace(candidate, '').trim();
      break;
    } catch {}
  }
  const status = res.status ?? null;
  const signal = res.signal ?? null;
  const detail = [parsed?.answer, parsed?.error && (typeof parsed.error === 'string' ? parsed.error : JSON.stringify(parsed.error)), stderr, nonJson, res.error?.message].filter(Boolean).join('\n').trim();
  const failureKind = status !== 0
    ? /cybersecurity|safety policy|policy[_ -](?:blocked|violation)|content.*flagged/i.test(detail) ? 'policy_blocked'
      : status === 130 || ['SIGINT', 'SIGTERM'].includes(signal) ? 'cancelled' : 'agent_error'
    : parsed ? null : 'invalid_output';
  return {
    status, signal, parsed, stdout, stderr, nonJson,
    session: parsed?.session || null, branch: parsed?.branch || null, head: parsed?.head || null, answer: parsed?.answer ?? '',
    failureKind, detail: detail.slice(-6000),
  };
}

const activeChildren = new Map();
function stopChildren(signal) {
  process.exitCode = signal === 'SIGINT' ? 130 : 143;
  for (const stop of activeChildren.values()) stop(signal);
}

// Keep the event loop free so independent planning sessions actually overlap.
export function callCodaAgentAsync(args, cwd = process.cwd(), { signal } = {}) {
  return new Promise(resolve => {
    const grouped = process.platform !== 'win32';
    const child = spawn('coda-agent', args, { cwd, detached: grouped, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', error, cancelled, killTimer, finished = false;
    const finish = (status, childSignal) => {
      if (finished) return;
      finished = true;
      clearTimeout(killTimer);
      activeChildren.delete(child);
      signal?.removeEventListener('abort', abort);
      if (!activeChildren.size) {
        process.removeListener('SIGINT', stopChildren);
        process.removeListener('SIGTERM', stopChildren);
      }
      resolve(parseAgentResult({ status: cancelled ? null : status, signal: cancelled || childSignal, stdout, stderr, error }));
    };
    const kill = signal => {
      if (grouped && child.pid) {
        try {
          process.kill(-child.pid, signal);
          if (signal !== 'SIGKILL') return;
        } catch {}
      }
      child.kill(signal);
    };
    const stop = reason => {
      if (cancelled || finished) return;
      cancelled = reason;
      kill('SIGTERM');
      killTimer = setTimeout(() => {
        kill('SIGKILL');
        child.stdin?.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
        // Inherited pipes must not keep cancellation waiting for close forever.
        finish(null, 'SIGKILL');
      }, Number(process.env.DICKDA_AGENT_KILL_GRACE_MS) || 1500);
    };
    const abort = () => stop('SIGTERM');
    if (!activeChildren.size) {
      process.on('SIGINT', stopChildren);
      process.on('SIGTERM', stopChildren);
    }
    activeChildren.set(child, stop);
    child.stdout.setEncoding('utf8').on('data', data => { stdout += data; });
    child.stderr.setEncoding('utf8').on('data', data => { stderr += data; });
    child.on('error', value => { error = value; });
    child.on('close', finish);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

export function agentResult(call) {
  return {
    session: call.session, branch: call.branch, worktree: call.worktree, dirtyFiles: call.dirtyFiles, inspectionError: call.inspectionError, head: call.head, exitCode: call.status, signal: call.signal,
    failureKind: call.failureKind, answer: call.answer, stderr: call.stderr,
    nonJson: call.nonJson, detail: call.detail,
  };
}

export function agentFailure(call) {
  return `coda-agent 退出码 ${call.status}；signal=${call.signal ?? 'none'}；session=${call.session ?? 'none'}；failureKind=${call.failureKind ?? 'gate_rejected'}${call.detail ? `\n${call.detail}` : ''}`;
}

function inspectDelivery(call, cwd) {
  if (call.status !== 0) return call;
  try {
    let worktree = cwd;
    if (call.branch) {
      const entries = execFileSync('git', ['-C', cwd, 'worktree', 'list', '--porcelain', '-z'], { encoding: 'utf8' }).split('\0\0');
      const entry = entries.map(record => record.split('\0')).find(lines => lines.includes(`branch refs/heads/${call.branch}`));
      if (!entry) throw new Error(`找不到 Agent 会话分支 ${call.branch} 的工作树`);
      worktree = entry.find(line => line.startsWith('worktree ')).slice(9);
    }
    const dirtyFiles = execFileSync('git', ['-C', worktree, 'status', '--porcelain', '--untracked-files=normal'], { encoding: 'utf8' }).trimEnd();
    return { ...call, worktree, dirtyFiles };
  } catch (error) {
    return { ...call, inspectionError: error.message };
  }
}

const needsCompletion = (call, baseHead) => !call.head || call.head === baseHead || call.dirtyFiles || call.inspectionError;
const completionPrompt = (prompt, call, baseHead, retry) => `${prompt}\n\n## Delivery Completion · 交付完成确认（${retry + 1}/2）\n请确认本会话启动的后台构建/测试已执行完毕，检查真实结果，将完整交付内容提交为基线 ${baseHead} 之上的干净 Git commit，并汇报提交 SHA。提交交付文件或清理临时文件，使工作树干净。不要仅回复正在等待；若确实受阻无法完成，请明确说明原因。不要推送或开 PR。\n${call.dirtyFiles ? `未干净文件（${call.worktree}）：\n${call.dirtyFiles}\n` : ''}${call.inspectionError ? `工作树检查失败：${call.inspectionError}\n` : ''}`;

function finishDelivery(call, attempts) {
  if (call.status === 0 && (call.dirtyFiles || call.inspectionError)) {
    call.failureKind = 'gate_rejected';
    call.detail = [call.detail, 'Agent 会话工作树未干净交付（最多续跑 2 次）', call.dirtyFiles, call.inspectionError].filter(Boolean).join('\n');
  }
  return { ...call, attempts };
}

// A new commit alone is not delivery: the session must also have a clean worktree.
export function callDeliveryAgent(args, { cwd, baseHead, promptFile, runner }) {
  let call = inspectDelivery(callCodaAgent(args, cwd, runner), cwd);
  const attempts = [agentResult(call)];
  const prompt = readFileSync(promptFile, 'utf8');
  for (let retry = 0; retry < 2 && call.status === 0 && call.session && needsCompletion(call, baseHead); retry++) {
    writeFileSync(promptFile, completionPrompt(prompt, call, baseHead, retry));
    const { session, branch } = call;
    call = callCodaAgent(['--continue', session, '--json', '--prompt-file', promptFile], cwd, runner);
    call.session ||= session;
    call.branch ||= branch;
    call = inspectDelivery(call, cwd);
    attempts.push(agentResult(call));
  }
  return finishDelivery(call, attempts);
}

export async function callDeliveryAgentAsync(args, { cwd, baseHead, promptFile, signal }) {
  let call = inspectDelivery(await callCodaAgentAsync(args, cwd, { signal }), cwd);
  const attempts = [agentResult(call)];
  const prompt = readFileSync(promptFile, 'utf8');
  for (let retry = 0; retry < 2 && call.status === 0 && call.session && needsCompletion(call, baseHead); retry++) {
    writeFileSync(promptFile, completionPrompt(prompt, call, baseHead, retry));
    const { session, branch } = call;
    call = await callCodaAgentAsync(['--continue', session, '--json', '--prompt-file', promptFile], cwd, { signal });
    call.session ||= session;
    call.branch ||= branch;
    call = inspectDelivery(call, cwd);
    attempts.push(agentResult(call));
  }
  return finishDelivery(call, attempts);
}
