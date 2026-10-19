// The locked ACP implementation keeps its own SDK and request lifecycle. These streams let
// Coda's additional methods share its wire without changing process.stdin or process.stdout.
import { PassThrough, Readable, Writable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';

export const input = new PassThrough();
let emit = message => process.stdout.write(`${JSON.stringify(message)}\n`);
let handler;
let pending = '';
const decoder = new StringDecoder('utf8');
const requests = new Map();
let nextId = 0;
export let clientCapabilities = {};
export const send = message => emit({ jsonrpc: '2.0', ...message });
export const notify = (method, params) => send({ method, params });
export const bind = value => { handler = value; };
export const isBound = () => Boolean(handler);
export const listen = value => { emit = value; };

const output = new Writable({ write(chunk, _, done) {
  pending += decoder.write(chunk);
  for (let end; (end = pending.indexOf('\n')) >= 0;) {
    const line = pending.slice(0, end); pending = pending.slice(end + 1);
    if (line.trim()) send(JSON.parse(line));
  }
  done();
} });
export const stream = { readable: Readable.toWeb(input), writable: Writable.toWeb(output) };

export function receive(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return;
  if (!message.method && requests.has(message.id)) {
    requests.get(message.id).finish(message.error ? Object.assign(new Error(message.error.message), message.error) : null, message.result);
    return;
  }
  if (message.method === 'initialize') clientCapabilities = message.params?.clientCapabilities ?? {};
  if (handler?.(message)) return;
  input.write(`${JSON.stringify(message)}\n`);
}

export function request(method, params, signal) {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('请求已取消'));
  const id = `coda-dsh-${++nextId}`;
  return new Promise((resolve, reject) => {
    const abort = () => {
      notify('$/cancel_request', { id });
      finish(signal?.reason ?? new Error('请求已取消'));
    };
    const finish = (error, result) => {
      if (!requests.delete(id)) return;
      signal?.removeEventListener('abort', abort);
      error ? reject(error) : resolve(result);
    };
    requests.set(id, { finish, abort, sessionId: params.sessionId });
    signal?.addEventListener('abort', abort, { once: true });
    send({ id, method, params });
  });
}

export function cancelRequests(sessionId) {
  for (const request of requests.values()) if (request.sessionId === sessionId) request.abort();
}

export function close() {
  for (const request of requests.values()) request.abort();
  input.end();
}
