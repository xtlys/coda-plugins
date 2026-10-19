// Copilot's Autopilot displays task_complete.summary as its final answer. Bridge that native convention to ACP text.
// Hold only trailing completions; if more output follows, replay the tools before it to preserve Coda's answer boundary.
import { randomUUID } from 'node:crypto';
import { SessionInstructions } from './instructions.mjs';

const record = value => value && typeof value === 'object' && !Array.isArray(value);
const hasText = update => update?.content?.type === 'text' && typeof update.content.text === 'string' && update.content.text.trim();
const text = value => typeof value === 'string' && value.trim() ? value : '';
const same = value => value.replaceAll('\r\n', '\n').trim();
const contentText = content => typeof content === 'string' ? text(content) : Array.isArray(content)
  ? content.map(part => part?.type === 'content' ? part.content : part).filter(part => part?.type === 'text').map(part => text(part.text)).filter(Boolean).join('\n') : '';
const summaryOf = call => text(call.rawOutput?.summary) || contentText(call.rawOutput?.content) || contentText(call.content) || text(call.rawInput?.summary);
const resetAnswer = turn => { turn.answer = ''; turn.lastAnswer = ''; turn.answerId = undefined; };

export class CopilotRelay {
  constructor({ say, tell }) {
    this.say = say; this.tell = tell;
    this.prompts = new Map(); this.turns = new Map();
    this.instructions = new SessionInstructions();
  }
  fromCoda(message) {
    const routed = this.instructions.fromCoda(message);
    if (routed.coda) { this.say(routed.coda); return; }
    if (message.method === 'session/prompt' && 'id' in message && typeof message.params?.sessionId === 'string') {
      const sessionId = message.params.sessionId;
      this.prompts.set(message.id, sessionId);
      this.turns.set(sessionId, { calls: new Map(), held: [], answer: '', lastAnswer: '', tools: new Set(), cancelled: false });
    }
    if (message.method === 'session/cancel') {
      const turn = this.turns.get(message.params?.sessionId);
      if (turn) turn.cancelled = true;
    }
    this.tell(routed.agent);
  }
  fromAgent(message) {
    message = this.instructions.fromAgent(message);
    if ('id' in message && !('method' in message) && this.prompts.has(message.id)) {
      const sessionId = this.prompts.get(message.id);
      this.prompts.delete(message.id);
      const missing = this.finish(sessionId, !('error' in message) && message.result?.stopReason === 'end_turn');
      this.say(missing ? { jsonrpc: '2.0', id: message.id, error: { code: -32603,
        message: 'Copilot 标记任务完成，但未提供答复正文或完成摘要。执行记录已保留。' } } : message);
      return;
    }
    const sessionId = message.params?.sessionId, turn = this.turns.get(sessionId);
    const update = message.method === 'session/update' ? message.params?.update : null;
    if (turn && record(update)) {
      const type = update.sessionUpdate, id = update.toolCallId;
      if (['tool_call', 'tool_call_update'].includes(type) && typeof id === 'string') {
        let call = turn.calls.get(id);
        if (!call && update.title === 'task_complete') {
          call = { forwarded: false }; turn.calls.set(id, call);
        }
        if (call) {
          Object.assign(call, update);
          if (call.forwarded) this.forward(turn, message);
          else {
            turn.held.push({ id, message });
            if (call.status === 'failed') this.flush(turn);
          }
          return;
        }
        // Updates to an earlier tool do not interrupt the current answer in Coda either.
        if (!turn.tools.has(id)) this.flush(turn);
      } else if (['agent_message_chunk', 'agent_thought_chunk'].includes(type) && hasText(update)) this.flush(turn);
    } else if (turn && ['session/request_permission', 'elicitation/create'].includes(message.method)) {
      this.flush(turn);
    }
    this.forward(turn, message);
  }
  forward(turn, message) {
    const update = message.method === 'session/update' ? message.params?.update : null;
    if (turn && record(update)) {
      const type = update.sessionUpdate, id = update.toolCallId;
      if (['tool_call', 'tool_call_update'].includes(type) && typeof id === 'string') {
        if (!turn.tools.has(id)) resetAnswer(turn);
        turn.tools.add(id);
      } else if (type === 'agent_message_chunk' && update.content?.type === 'text' && typeof update.content.text === 'string') {
        if (turn.answerId !== update.messageId) turn.lastAnswer = '';
        turn.answerId = update.messageId;
        turn.answer += update.content.text;
        turn.lastAnswer += update.content.text;
      } else if (type === 'agent_thought_chunk' && hasText(update)) {
        resetAnswer(turn);
      }
    } else if (turn && ['session/request_permission', 'elicitation/create'].includes(message.method)) resetAnswer(turn);
    this.say(message);
  }
  flush(turn, omitCompleted = false) {
    for (const { id, message } of turn.held) {
      const call = turn.calls.get(id);
      if (omitCompleted && call.status === 'completed') continue;
      call.forwarded = true;
      this.forward(turn, message);
    }
    turn.held = [];
  }
  finish(sessionId, succeeded) {
    const turn = this.turns.get(sessionId);
    if (!turn) return;
    this.turns.delete(sessionId);
    const completed = [...turn.calls.values()].some(call => call.status === 'completed');
    const normal = succeeded && !turn.cancelled;
    const settled = turn.held.every(({ id }) => turn.calls.get(id).status === 'completed');
    const summary = normal && settled ? turn.held.map(({ id }) => summaryOf(turn.calls.get(id))).filter(Boolean).at(-1) ?? '' : '';
    const omit = normal && settled && (summary || turn.answer.trim());
    this.flush(turn, omit);
    if (summary && ![turn.answer, turn.lastAnswer].some(answer => same(answer) === same(summary))) this.forward(turn, {
      jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: {
        sessionUpdate: 'agent_message_chunk', messageId: `copilot-completion-${randomUUID()}`, content: { type: 'text', text: summary },
      } },
    });
    return normal && completed && !turn.answer.trim();
  }
  close() {
    for (const sessionId of this.turns.keys()) this.finish(sessionId, false);
    this.prompts.clear();
  }
}
