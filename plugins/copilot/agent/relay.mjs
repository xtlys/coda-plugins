// Copilot delivers some final replies only through its task_complete tool. Keep that native convention here: successful
// completions become ACP answer text before the prompt result. Failed/incomplete calls keep their original tool records.
// Hold just these notifications until the result, so equivalent native text needs neither a duplicate nor a trailing tool
// that would hide it from Coda's final-answer boundary. Everything else passes through while the turn is running.
import { randomUUID } from 'node:crypto';

const record = value => value && typeof value === 'object' && !Array.isArray(value);
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
  }
  fromCoda(message) {
    if (message.method === 'session/prompt' && 'id' in message && typeof message.params?.sessionId === 'string') {
      const sessionId = message.params.sessionId;
      this.prompts.set(message.id, sessionId);
      this.turns.set(sessionId, { calls: new Map(), held: [], answer: '', lastAnswer: '', tools: new Set() });
    }
    this.tell(message);
  }
  fromAgent(message) {
    if ('id' in message && !('method' in message) && this.prompts.has(message.id)) {
      const sessionId = this.prompts.get(message.id);
      this.prompts.delete(message.id);
      this.finish(sessionId, !('error' in message) && message.result?.stopReason === 'end_turn');
      this.say(message);
      return;
    }
    const sessionId = message.params?.sessionId, turn = this.turns.get(sessionId);
    const update = message.method === 'session/update' ? message.params?.update : null;
    if (turn && record(update)) {
      const type = update.sessionUpdate, id = update.toolCallId;
      if (['tool_call', 'tool_call_update'].includes(type) && typeof id === 'string') {
        let call = turn.calls.get(id);
        if (!call && update.title === 'task_complete') {
          call = {}; turn.calls.set(id, call);
        }
        if (call) {
          Object.assign(call, update);
          turn.held.push({ id, message });
          return;
        }
        // Updates to an earlier tool do not interrupt the current answer in Coda either.
        if (!turn.tools.has(id)) resetAnswer(turn);
        turn.tools.add(id);
      } else if (type === 'agent_message_chunk' && update.content?.type === 'text' && typeof update.content.text === 'string') {
        if (turn.answerId !== update.messageId) turn.lastAnswer = '';
        turn.answerId = update.messageId;
        turn.answer += update.content.text;
        turn.lastAnswer += update.content.text;
      } else if (type === 'agent_thought_chunk' && update.content?.type === 'text' && text(update.content.text)) {
        resetAnswer(turn);
      }
    } else if (turn && ['session/request_permission', 'elicitation/create'].includes(message.method)) {
      resetAnswer(turn);
    }
    this.say(message);
  }
  finish(sessionId, succeeded) {
    const turn = this.turns.get(sessionId);
    if (!turn) return;
    this.turns.delete(sessionId);
    const converted = new Set();
    let summary = '';
    if (succeeded) {
      // Use the last completed call's summary if Copilot completed more than once in one prompt.
      for (const { id } of turn.held) {
        const call = turn.calls.get(id), value = call.status === 'completed' ? summaryOf(call) : '';
        if (value) { converted.add(id); summary = value; }
      }
    }
    for (const { id, message } of turn.held) {
      if (converted.has(id)) continue;
      this.say(message);
      resetAnswer(turn);
    }
    if (summary && ![turn.answer, turn.lastAnswer].some(answer => same(answer) === same(summary))) this.say({ jsonrpc: '2.0', method: 'session/update', params: {
      sessionId, update: { sessionUpdate: 'agent_message_chunk', messageId: `copilot-completion-${randomUUID()}`,
        content: { type: 'text', text: summary } },
    } });
  }
  close() {
    for (const sessionId of this.turns.keys()) this.finish(sessionId, false);
    this.prompts.clear();
  }
}
