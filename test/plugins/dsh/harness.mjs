import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AgentProcess } from '../../../check/process.mjs';
import { pluginDir } from '../plugin.mjs';

export const instructions = text => ({ mode: 'append', content: [{ type: 'text', text }] });
export const text = value => [{ type: 'text', text: value }];
export const caps = { elicitation: { form: {} }, session: { compaction: {} }, _meta: { coda: { waits: {} } } };
export async function until(predicate) {
  for (let i = 0; i < 1000; i++) { if (predicate()) return; await delay(10); }
  throw new Error('没有等到预期事件');
}

export function complete(response, content = text('ok'), stop = 'end_turn') {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const send = event => response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  send({ type: 'message_start', message: { id: 'mock', type: 'message', role: 'assistant', model: 'deepseek-flash', content: [], usage: { input_tokens: 42, output_tokens: 0 } } });
  content.forEach((block, index) => {
    const tool = block.type === 'tool_use';
    send({ type: 'content_block_start', index, content_block: tool ? { ...block, input: {} } : { type: block.type, text: '' } });
    send({ type: 'content_block_delta', index, delta: tool ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } : { type: 'text_delta', text: block.text } });
    send({ type: 'content_block_stop', index });
  });
  send({ type: 'message_delta', delta: { stop_reason: stop }, usage: { output_tokens: 8 } });
  send({ type: 'message_stop' });
  response.end();
}

export async function harness(t, reply = (_body, response) => complete(response)) {
  const dir = mkdtempSync(join(tmpdir(), 'coda-dsh-test-'));
  const requests = [], agents = [], errors = [];
  const server = createServer(async (req, res) => {
    try {
      const buffers = []; for await (const chunk of req) buffers.push(chunk);
      const body = JSON.parse(Buffer.concat(buffers).toString());
      requests.push(body); await reply(body, res, requests.length, req);
    } catch (error) { errors.push(error); res.writeHead(500); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const env = { PATH: process.env.PATH, HOME: dir, DSH_HOME: join(dir, '.dsh'), DSH_AGENTS_HOME: join(dir, '.agents'),
    DEEPSEEK_BASE_URL: `http://127.0.0.1:${server.address().port}`, DEEPSEEK_API_KEY: 'test-key',
    DSH_TELEMETRY_DISABLED: '1', CODA_NODE: process.execPath, CODA_PLUGIN_PATH: pluginDir('dsh') };
  t.after(async () => {
    for (const agent of agents) { await agent.terminate(1500); agent.kill(); }
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
    if (errors.length) throw errors[0];
  });
  async function start(extra = {}, clientCapabilities = caps) {
    const messages = [], noise = [];
    const agent = new AgentProcess({ command: 'exec "$CODA_NODE" "$CODA_PLUGIN_PATH/agent/entry.mjs"', cwd: dir, env: { ...env, ...extra },
      onMessage: message => messages.push(message), onNoise: line => noise.push(line) });
    agents.push(agent);
    const request = (method, params) => agent.request(method, params, { timeout: 15000 });
    const init = await request('initialize', { protocolVersion: 1, clientCapabilities });
    return { agent, request, messages, noise, init,
      newSession: (content = 'Coda 测试 {{literal}}') => request('session/new', { cwd: dir, mcpServers: [], systemPrompt: instructions(content) }),
      prompt: (sessionId, value) => request('session/prompt', { sessionId, prompt: text(value) }) };
  }
  return { dir, requests, env, start };
}
