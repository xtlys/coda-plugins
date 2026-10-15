// A real subprocess speaking the SDK server's framed JSON-RPC. It never reads credentials or makes network calls.
import { appendFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

const mode = process.env.FAKE_COPILOT_MODE;
const trace = event => appendFileSync(process.env.FAKE_COPILOT_TRACE, `${JSON.stringify(event)}\n`);
trace({ event: 'start', pid: process.pid, args: process.argv.slice(2) });
// Keep the server alive after stdin ends, so tests prove the caller terminates it on every outcome.
setInterval(() => {}, 60_000);
process.on('SIGTERM', () => {
  trace({ event: 'signal', signal: 'SIGTERM' });
  if (mode !== 'ignore-sigterm') process.exit(0);
});

async function answer(message) {
  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...message }));
  const frame = Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]);
  const chinese = frame.indexOf(Buffer.from('张'));
  if (mode === 'fragmented' && chinese >= 0) {
    // Split the header and both the three-byte Chinese character and the four-byte emoji across writes.
    const emoji = frame.indexOf(Buffer.from('🐙'));
    const cuts = [0, 2, frame.indexOf('\r\n\r\n') + 2, chinese + 1, chinese + 2, emoji + 1, emoji + 3, frame.length];
    for (let i = 1; i < cuts.length; i++) {
      process.stdout.write(frame.subarray(cuts[i - 1], cuts[i]));
      await delay(8);
    }
  } else process.stdout.write(frame);
}

function receive(message, byteLength) {
  trace({ event: 'request', message, byteLength });
  if (message.jsonrpc !== '2.0' || typeof message.id !== 'string' || !message.method ||
      !message.params || Object.keys(message.params).length) process.exit(31);
  if (mode === 'early-exit') process.exit(23);
  if (mode === 'silent') return;
  if (mode === 'invalid-length') { process.stdout.write('Content-Length: 1048577\r\n\r\n'); return; }
  if (mode === 'invalid-json') { process.stdout.write('Content-Length: 1\r\n\r\n{'); return; }
  const result = value => answer({ id: message.id, result: value });
  const error = code => answer({ id: message.id, error: { code, message: 'FAKE_SECRET_TOKEN server diagnostic' } });
  if (message.method === 'connect') {
    if (mode === 'fallback') error(-32601);
    else result({});
  } else if (message.method === 'ping') result({});
  else if (message.method === 'auth.getStatus') result(mode === 'missing-auth' ? {} : {
    isAuthenticated: mode !== 'signed-out', login: '张三🐙', authType: 'user',
  });
  else if (message.method === 'account.getQuota') {
    if (mode === 'server-error') error(-32001);
    else if (mode === 'unsupported') error(-32601);
    else result({ quotaSnapshots: { premium_interactions: { remainingPercentage: 73.5 } } });
  } else error(-32601);
}

let buffer = Buffer.alloc(0), length = null;
process.stdin.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  while (buffer.length) {
    if (length === null) {
      const end = buffer.indexOf('\r\n\r\n');
      if (end < 0) return;
      const header = /^Content-Length: (\d+)$/.exec(buffer.subarray(0, end).toString('ascii'));
      if (!header) process.exit(32);
      length = Number(header[1]);
      buffer = buffer.subarray(end + 4);
    }
    if (buffer.length < length) return;
    const body = buffer.subarray(0, length), byteLength = length;
    buffer = buffer.subarray(length); length = null;
    receive(JSON.parse(body.toString('utf8')), byteLength);
  }
});
