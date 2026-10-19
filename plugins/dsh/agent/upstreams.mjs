// `dsh/upstream-source` uses private, newline-delimited JSON on stdin/stdout:
//   -> { id, method: "selected" }
//   <- { id, result: { upstream: { id, name, baseUrl, apiKey } } }
//   <- { id, error: { message } }
// Each model call captures one complete reply. Credentials never enter environment,
// settings or session logs, and a missing selection never falls back to native auth.
import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';

export function upstreamSource(env = process.env) {
  let extensions;
  try { extensions = JSON.parse(env.CODA_PLUGIN_EXTENSIONS || '{}'); }
  catch { throw new Error('Coda 的 DSH 扩展配置无效'); }
  const source = extensions?.['upstream-source']?.[0];
  if (source === undefined) return null;
  if (!source || typeof source.command !== 'string' || !source.command || typeof source.path !== 'string' || !source.path)
    throw new Error('Coda 的 DSH 上游来源配置无效');
  return source;
}

export class UpstreamSource {
  constructor(source, { env = process.env, timeoutMs = 10000 } = {}) {
    this.source = source; this.env = env; this.timeoutMs = timeoutMs;
    this.child = null; this.pending = new Map(); this.serial = 0; this.closed = false;
  }
  start() {
    const env = { ...this.env, CODA_NODE: process.execPath, CODA_PLUGIN_PATH: this.source.path,
      CODA_PLUGIN_DEPENDENCIES: JSON.stringify({ dsh: this.env.CODA_PLUGIN_PATH }),
      PATH: [dirname(process.execPath), this.env.PATH].filter(Boolean).join(':') };
    delete env.CODA_PLUGIN_SETTINGS; delete env.CODA_PLUGIN_EXTENSIONS; delete env.CODA_PLUGIN_STATE;
    if (this.source.state) env.CODA_PLUGIN_STATE = this.source.state;
    const child = spawn('/bin/sh', ['-c', this.source.command], { env, stdio: ['pipe', 'pipe', 'ignore'] });
    child.stdin.on('error', () => {});
    const fail = message => {
      if (this.child === child) this.child = null;
      for (const pending of this.pending.values()) if (pending.child === child) pending.finish(new Error(message));
    };
    const lines = createInterface({ input: child.stdout });
    lines.on('line', line => {
      if (Buffer.byteLength(line) > 32 * 1024) { fail('DSH 上游来源的答复过大'); child.kill(); return; }
      let reply;
      try { reply = JSON.parse(line); } catch { fail('DSH 上游来源的答复无效'); child.kill(); return; }
      const pending = this.pending.get(reply?.id);
      if (!pending || pending.child !== child) return;
      if (reply.error) pending.finish(new Error(typeof reply.error.message === 'string' ? reply.error.message.slice(0, 200) : 'DSH 上游来源拒绝了请求'));
      else pending.finish(null, reply.result);
    });
    child.once('error', () => fail('无法启动 DSH 上游来源'));
    child.once('close', () => fail('DSH 上游来源已退出'));
    return child;
  }
  async selected(signal) {
    signal?.throwIfAborted();
    if (this.closed) throw new Error('DSH 上游来源已关闭');
    const child = this.child ??= this.start(), id = ++this.serial;
    const result = await new Promise((resolve, reject) => {
      const finish = (error, value) => {
        if (!this.pending.delete(id)) return;
        clearTimeout(timer); signal?.removeEventListener('abort', abort);
        error ? reject(error) : resolve(value);
      };
      const abort = () => finish(signal.reason ?? new Error('上游请求已取消'));
      const timer = setTimeout(() => {
        finish(new Error('DSH 上游来源没有答复')); child.kill();
      }, this.timeoutMs);
      this.pending.set(id, { finish, child });
      signal?.addEventListener('abort', abort, { once: true });
      child.stdin.write(`${JSON.stringify({ id, method: 'selected' })}\n`);
    });
    const upstream = result?.upstream;
    if (!upstream || typeof upstream.id !== 'string' || !upstream.id || typeof upstream.name !== 'string'
      || typeof upstream.apiKey !== 'string' || upstream.apiKey.length > 4096 || !/^[\x21-\x7e]+$/.test(upstream.apiKey)
      || typeof upstream.baseUrl !== 'string' || upstream.baseUrl.length > 2048 || /[\x00-\x20\x7f\\?#]/.test(upstream.baseUrl))
      throw new Error('DSH 上游来源给出的配置不完整或无效');
    let url;
    try { url = new URL(upstream.baseUrl); } catch { throw new Error('DSH 上游来源给出的 base_url 无效'); }
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash)
      throw new Error('DSH 上游来源给出的 base_url 无效');
    return { id: upstream.id, name: upstream.name, baseUrl: url.href.replace(/\/+$/, ''), apiKey: upstream.apiKey };
  }
  close() {
    this.closed = true;
    for (const pending of this.pending.values()) pending.finish(new Error('DSH 上游来源已关闭'));
    this.pending.clear();
    this.child?.stdin.end(); this.child?.kill(); this.child = null;
  }
}

const credentials = new WeakMap();
let source;
export function closeUpstreamSource() { source?.close(); }
export function upstreamProvider(native, catalogModelInfo, LlmError) {
  const extension = upstreamSource();
  if (!extension) return native;
  source ??= new UpstreamSource(extension);
  const connect = async signal => {
    const options = native.options();
    try {
      const upstream = await source.selected(signal);
      const connection = { ...options, baseURL: upstream.baseUrl };
      credentials.set(connection, { apiKey: upstream.apiKey });
      return connection;
    } catch (cause) {
      // Model capability lookup also calls connect, including before authentication.
      // Keep metadata available, but refuse discovery and dispatch with this error.
      const error = Object.assign(new LlmError(cause.message, 'MISSING_CREDENTIAL'), { upstreamSource: true });
      credentials.set(options, { error });
      return options;
    }
  };
  const key = connection => {
    const held = credentials.get(connection);
    if (held?.error) throw held.error;
    if (!held?.apiKey) throw Object.assign(new LlmError('DSH 上游凭据快照不可用', 'MISSING_CREDENTIAL'), { upstreamSource: true });
    return held.apiKey;
  };
  return { ...native, connect,
    resolveAuth: async connection => ({ headers: { 'x-api-key': key(connection) } }),
    discoverModels: async provider => {
      const connection = await connect(); key(connection);
      return connection.models.map(model => catalogModelInfo(provider, model));
    },
  };
}

export function patchedUpstream(source) {
  const before = 'registerDeepSeekProvider(ctx, PROVIDER, {';
  const end = '\n\t});\n}\n//#endregion\nexport {';
  if (source.split(before).length !== 2 || source.split(end).length !== 2)
    throw new Error('dsh 上游适配器 0.2.1-rc.2 的接入点已变化');
  return `import { upstreamProvider } from ${JSON.stringify(import.meta.url)};\n${source.replace(before, 'registerDeepSeekProvider(ctx, PROVIDER, upstreamProvider({').replace(end, '\n\t}, catalogModelInfo, LlmError));\n}\n//#endregion\nexport {')}`;
}
