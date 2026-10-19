// Private newline-delimited IPC. This is the only command that returns saved credentials.
import { createInterface } from 'node:readline';
import { selected } from './manager.mjs';

createInterface({ input: process.stdin }).on('line', line => {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  if (request?.id === undefined) return;
  let reply;
  try {
    if (request.method !== 'selected') throw new Error('不支持的上游请求');
    reply = { result: { upstream: selected() } };
  } catch (error) { reply = { error: { message: error.message } }; }
  process.stdout.write(`${JSON.stringify({ id: request.id, ...reply })}\n`);
});
