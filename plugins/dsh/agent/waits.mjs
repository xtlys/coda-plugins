// One native activation includes its descendants and final parent delivery.
// Resuming a completed child uses a fresh waitId and the same childSessionId.
export class DshWaits {
  constructor(send, enabled) { this.send = send; this.enabled = enabled; this.items = new Map(); this.serial = 0; }
  start(sessionId, key, fields, stop) {
    const previous = this.items.get(key);
    if (previous && !previous.ended) return previous;
    const item = { sessionId, waitId: `dsh-${++this.serial}`, ...fields, stop, state: 'waiting', ended: false, terminal: undefined };
    this.items.set(key, item);
    const { autonomous, ...publicFields } = fields;
    this.report(item, { ...publicFields, stoppable: Boolean(stop) });
    return item;
  }
  report(item, fields = {}) {
    if (this.enabled()) this.send({ sessionId: item.sessionId, waitId: item.waitId, state: item.state, ...fields });
  }
  update(key, fields) {
    const item = this.items.get(key);
    if (!item || item.ended || Object.entries(fields).every(([name, value]) => item[name] === value)) return;
    Object.assign(item, fields); this.report(item, fields);
  }
  handling(key) {
    const item = this.items.get(key);
    if (!item || item.ended || item.state === 'handling') return;
    item.state = 'handling'; this.report(item);
  }
  finish(key, terminal = 'done') {
    const item = this.items.get(key);
    if (!item || item.ended) return;
    item.terminal = terminal;
    if (item.state !== 'handling') this.end(item, terminal);
  }
  end(item, state) { item.state = state; item.ended = true; this.report(item); }
  idle(sessionId, cancelled = false) {
    for (const item of this.items.values()) if (item.sessionId === sessionId && item.state === 'handling') {
      if (item.terminal) this.end(item, item.terminal);
      else if (item.kind === 'task' && item.autonomous) this.end(item, cancelled ? 'cancelled' : 'done');
      else { item.state = 'waiting'; this.report(item); }
    }
  }
  async stop(sessionId, waitId) {
    const item = [...this.items.values()].find(w => w.sessionId === sessionId && w.waitId === waitId && !w.ended);
    if (!item?.stop) throw new Error('没有可以停止的活动');
    await item.stop();
  }
}
