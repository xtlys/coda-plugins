// An isolated Copilot stand-in; no real credentials or model calls. It insists on the native ACP arguments.
import { createInterface } from 'node:readline';
if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(['--acp', '--stdio'])) process.exit(64);
const say = message => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.method !== 'session/prompt') return;
  const scenario = message.params.prompt.at(-1).text;
  const summary = '文档已写好，改动尚未提交。';
  const update = value => say({ method: 'session/update', params: { sessionId: message.params.sessionId, update: value } });
  if (scenario === 'duplicate') update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: summary } });
  update({ sessionUpdate: 'tool_call', toolCallId: 'complete', title: 'task_complete', status: 'in_progress', rawInput: { summary } });
  update({ sessionUpdate: 'tool_call_update', toolCallId: 'complete', status: 'completed', rawOutput: { summary } });
  if (scenario === 'exit') process.stdout.write('', () => process.exit(7));
  else if (scenario === 'error') say({ id: message.id, error: { code: -32603, message: 'upstream error' } });
  else say({ id: message.id, result: { stopReason: 'end_turn' } });
}).on('close', () => process.exit(0));
