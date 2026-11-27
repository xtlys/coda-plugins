import { spawn, spawnSync } from 'node:child_process';
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
    session: parsed?.session || null, head: parsed?.head || null, answer: parsed?.answer ?? '',
    failureKind, detail: detail.slice(-6000),
  };
}

const activeChildren = new Map();
function stopChildren(signal) {
  process.exitCode = signal === 'SIGINT' ? 130 : 143;
  for (const child of activeChildren.keys()) {
    activeChildren.set(child, signal);
    child.kill(signal);
  }
}

// Keep the event loop free so independent planning sessions actually overlap.
export function callCodaAgentAsync(args, cwd = process.cwd(), { signal } = {}) {
  return new Promise(resolve => {
    const child = spawn('coda-agent', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    if (!activeChildren.size) {
      process.on('SIGINT', stopChildren);
      process.on('SIGTERM', stopChildren);
    }
    activeChildren.set(child, null);
    const abort = () => {
      activeChildren.set(child, 'SIGTERM');
      child.kill('SIGTERM');
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    let stdout = '', stderr = '', error;
    child.stdout.setEncoding('utf8').on('data', data => { stdout += data; });
    child.stderr.setEncoding('utf8').on('data', data => { stderr += data; });
    child.on('error', value => { error = value; });
    child.on('close', (status, childSignal) => {
      const cancelled = activeChildren.get(child);
      activeChildren.delete(child);
      signal?.removeEventListener('abort', abort);
      if (!activeChildren.size) {
        process.removeListener('SIGINT', stopChildren);
        process.removeListener('SIGTERM', stopChildren);
      }
      resolve(parseAgentResult({ status: cancelled ? null : status, signal: cancelled || childSignal, stdout, stderr, error }));
    });
  });
}

export function agentResult(call) {
  return {
    session: call.session, head: call.head, exitCode: call.status, signal: call.signal,
    failureKind: call.failureKind, answer: call.answer, stderr: call.stderr,
    nonJson: call.nonJson, detail: call.detail,
  };
}

export function agentFailure(call) {
  return `coda-agent 退出码 ${call.status}；signal=${call.signal ?? 'none'}；session=${call.session ?? 'none'}；failureKind=${call.failureKind ?? 'gate_rejected'}${call.detail ? `\n${call.detail}` : ''}`;
}

// A successful turn may only have started background work. Continue that same session at most twice.
export function callDeliveryAgent(args, { cwd, baseHead, promptFile, runner }) {
  let call = callCodaAgent(args, cwd, runner);
  const attempts = [agentResult(call)];
  const prompt = readFileSync(promptFile, 'utf8');
  for (let retry = 0; retry < 2 && call.status === 0 && call.session && (!call.head || call.head === baseHead); retry++) {
    writeFileSync(promptFile, `${prompt}\n\n## 交付完成确认（${retry + 1}/2）\n请确认本会话启动的后台构建/测试已执行完毕，检查真实结果，将改动提交为基线 ${baseHead} 之上的干净 Git commit，并汇报提交 SHA。不要仅回复正在等待；若确实受阻无法完成，请明确说明原因。不要推送或开 PR。\n`);
    const session = call.session;
    call = callCodaAgent(['--continue', session, '--json', '--prompt-file', promptFile], cwd, runner);
    call.session ||= session;
    attempts.push(agentResult(call));
  }
  return { ...call, attempts };
}

export async function callDeliveryAgentAsync(args, { cwd, baseHead, promptFile, signal }) {
  let call = await callCodaAgentAsync(args, cwd, { signal });
  const attempts = [agentResult(call)];
  const prompt = readFileSync(promptFile, 'utf8');
  for (let retry = 0; retry < 2 && call.status === 0 && call.session && (!call.head || call.head === baseHead); retry++) {
    writeFileSync(promptFile, `${prompt}\n\n## Delivery Completion (${retry + 1}/2)\n确认本会话后台检查的实际结果，将完整 PLAN_5L.md 提交为 ${baseHead} 的严格后代，汇报 SHA。受阻则说明原因。不要推送或开 PR。\n`);
    const session = call.session;
    call = await callCodaAgentAsync(['--continue', session, '--json', '--prompt-file', promptFile], cwd, { signal });
    call.session ||= session;
    attempts.push(agentResult(call));
  }
  return { ...call, attempts };
}
