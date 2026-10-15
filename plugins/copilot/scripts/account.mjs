// A short-lived Copilot SDK server, separate from the agent's native ACP connection. These are the RPCs used by the
// SDK: connect, auth.getStatus and account.getQuota, with Content-Length framing. No session or credential read is needed.
import { spawn } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';

export function copilotBinary(env = process.env) {
  const candidates = [join(env.HOME || homedir(), '.local/bin/copilot'),
    ...(env.PATH ?? '').split(delimiter).filter(Boolean).map(dir => resolve(dir, 'copilot'))];
  return candidates.find(path => {
    try { accessSync(path, constants.X_OK); return statSync(path).isFile(); } catch { return false; }
  }) ?? null;
}

const FRAME_LIMIT = 1024 * 1024;
const labels = { connect: '连接', ping: '连接', 'auth.getStatus': '登录状态', 'account.getQuota': '额度' };
class RpcError extends Error {
  constructor(method, code) {
    super(code === -32601 ? `当前 Copilot CLI 不支持${labels[method]}查询，请升级 CLI`
      : `Copilot ${labels[method]}查询失败${Number.isInteger(code) ? `（错误码 ${code}）` : ''}`);
    this.code = code;
  }
}

export async function readAccount({ env = process.env, binary = copilotBinary(env), timeoutMs = 20_000, stopMs = 800 } = {}) {
  if (!binary) throw new Error('找不到 Copilot CLI，请先安装并在运行机终端运行 copilot login');
  const child = spawn(binary, ['--headless', '--stdio', '--no-auto-update', '--log-level', 'none'],
    { cwd: tmpdir(), env, stdio: ['pipe', 'pipe', 'ignore'] });
  const pending = new Map();
  let next = 0, buffer = Buffer.alloc(0), length = null, finished = false, closed = false, rejectFailure;
  const exited = new Promise(resolve => child.once('close', () => { closed = true; resolve(); }));
  const failure = new Promise((_, reject) => { rejectFailure = reject; });
  const fail = error => {
    if (finished) return;
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear(); rejectFailure(error);
  };
  const send = message => {
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...message }));
    child.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]));
  };
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const id = `quota-${next++}`;
    pending.set(id, { method, resolve, reject }); send({ id, method, params });
  });
  child.once('error', () => fail(new Error('无法启动 Copilot CLI，请检查安装与执行权限')));
  child.once('close', () => fail(new Error('Copilot CLI 在查询完成前退出')));
  child.stdin.on('error', () => fail(new Error('Copilot CLI 的查询连接已关闭')));
  child.stdout.on('data', chunk => {
    if (finished) return;
    buffer = Buffer.concat([buffer, chunk]);
    try {
      while (buffer.length) {
        if (length === null) {
          const end = buffer.indexOf('\r\n\r\n');
          if (end < 0) { if (buffer.length > 16_384) throw new Error('Copilot 返回了无效的消息头'); break; }
          const found = /^Content-Length:\s*(\d+)\s*$/im.exec(buffer.subarray(0, end).toString('ascii'));
          length = found ? Number(found[1]) : NaN;
          if (!Number.isSafeInteger(length) || length <= 0 || length > FRAME_LIMIT) throw new Error('Copilot 返回了无效的消息长度');
          buffer = buffer.subarray(end + 4);
        }
        if (buffer.length < length) break;
        let message;
        try { message = JSON.parse(buffer.subarray(0, length).toString('utf8')); }
        catch { throw new Error('Copilot 返回了无效的查询结果'); }
        buffer = buffer.subarray(length); length = null;
        if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('Copilot 返回了无效的查询结果');
        if (typeof message.method === 'string') {
          if (Object.hasOwn(message, 'id')) send({ id: message.id, error: { code: -32601, message: 'Method not found' } });
          continue;
        }
        const waiter = pending.get(message.id);
        if (!waiter) continue;
        pending.delete(message.id);
        if (message.error) waiter.reject(new RpcError(waiter.method, message.error.code));
        else if (!Object.hasOwn(message, 'result')) waiter.reject(new Error('Copilot 返回了无效的查询结果'));
        else waiter.resolve(message.result);
      }
    } catch (error) { fail(error); }
  });
  const timer = setTimeout(() => fail(new Error('Copilot 额度查询超时，请稍后重试')), timeoutMs);
  const waitForExit = async ms => {
    let timer;
    await Promise.race([exited, new Promise(resolve => { timer = setTimeout(resolve, ms); })]);
    clearTimeout(timer);
  };
  try {
    return await Promise.race([failure, (async () => {
      try { await request('connect'); }
      catch (error) { if (error.code !== -32601) throw error; await request('ping'); }
      const auth = await request('auth.getStatus');
      if (typeof auth?.isAuthenticated !== 'boolean') throw new Error('Copilot 没有说明登录状态');
      return { auth, ...(auth.isAuthenticated ? { quota: await request('account.getQuota') } : {}) };
    })()]);
  } finally {
    finished = true; clearTimeout(timer); pending.clear();
    child.stdin.end(); child.kill('SIGTERM');
    await waitForExit(stopMs);
    if (!closed) { child.kill('SIGKILL'); await waitForExit(stopMs); }
  }
}
