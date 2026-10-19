// Native Copilot ACP does not accept Coda's systemPrompt. Carry it in a separate text block on the first normal prompt
// of a new native session, as the other CLI relays do. Loaded sessions retain their original instructions.
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const OPENING = '<coda-session-instructions>';
const REPLY_OPENING = '<coda-reply-instructions>';

export function sessionInstructions(value) {
  if (value === undefined || value === null) return '';
  if (!record(value) || value.mode !== 'append') throw new Error('会话指令只支持 append 模式');
  if (!Array.isArray(value.content) || value.content.some(block => block?.type !== 'text' || typeof block.text !== 'string')) throw new Error('会话指令只接受文本块');
  const text = value.content.map(block => block.text).join('\n\n');
  if (Buffer.byteLength(text, 'utf8') > 1024 * 1024) throw new Error('会话指令不能超过 1 MiB');
  return text;
}

export const REPLY_INSTRUCTIONS = 'Coda displays your final answer directly to the user. '
  + 'When using task_complete (including Autopilot mode), its summary is this final answer, not an internal status log. '
  + 'Put the complete, self-contained Markdown answer in summary: answer every user question and include the actual explanations, results and important limitations. '
  + 'Do not merely say you explained or completed something (for example, "解释了 X") or refer to an answer that was never displayed. '
  + 'Private reasoning is not user-visible. If you finish without task_complete, deliver the complete answer as a normal assistant text message.';

const instructionsBlock = text => ({ type: 'text', text: `${OPENING}\n`
  + 'Instructions from Coda, the client this session runs in, for the whole session. They are not part of the user\'s message.\n\n'
  + `${text}\n</coda-session-instructions>\n` });
const replyBlock = () => ({ type: 'text', text: `${REPLY_OPENING}\n${REPLY_INSTRUCTIONS}\n</coda-reply-instructions>\n` });

export class SessionInstructions {
  constructor() { this.asked = new Map(); this.waiting = new Map(); }
  fromCoda(message) {
    const { id, method, params } = message;
    if (!record(params)) return { agent: message };
    if (method === 'initialize' && id !== undefined) this.asked.set(id, { initialize: true });
    if (method === 'session/new' || method === 'session/load') {
      let text;
      try { text = sessionInstructions(params.systemPrompt); }
      catch (error) { return { coda: { jsonrpc: '2.0', id, error: { code: -32602, message: error.message } } }; }
      const { systemPrompt, ...rest } = params;
      if (method === 'session/new' && text && id !== undefined) this.asked.set(id, { text });
      return { agent: { ...message, params: rest } };
    }
    if (method === 'session/prompt' && Array.isArray(params.prompt)) {
      const first = params.prompt.find(block => block?.type === 'text');
      if (typeof first?.text === 'string' && first.text.trimStart().startsWith('/')) return { agent: message };
      const text = this.waiting.get(params.sessionId);
      this.waiting.delete(params.sessionId);
      // Keep the reply contract on resumed sessions and after context compaction as well.
      return { agent: { ...message, params: { ...params, prompt: [...(text ? [instructionsBlock(text)] : []), replyBlock(), ...params.prompt] } } };
    }
    return { agent: message };
  }
  fromAgent(message) {
    const update = message.method === 'session/update' ? message.params?.update : null;
    if (record(update) && update.sessionUpdate === 'session_info_update' && typeof update.title === 'string'
      && [OPENING, REPLY_OPENING].some(prefix => update.title.trimStart().startsWith(prefix))) {
      const { title, ...rest } = update;
      return { ...message, params: { ...message.params, update: rest } };
    }
    if (!('id' in message) || 'method' in message) return message;
    const asked = this.asked.get(message.id);
    if (!asked) return message;
    this.asked.delete(message.id);
    if (!record(message.result)) return message;
    if (asked.text) {
      if (typeof message.result.sessionId === 'string') this.waiting.set(message.result.sessionId, asked.text);
      return message;
    }
    const capabilities = record(message.result.agentCapabilities) ? message.result.agentCapabilities : {};
    const sessions = record(capabilities.sessionCapabilities) ? capabilities.sessionCapabilities : {};
    return { ...message, result: { ...message.result, agentCapabilities: { ...capabilities, sessionCapabilities: { ...sessions, systemPrompt: {} } } } };
  }
}
