// Only typed provider facts qualify for Coda's retry policy. The native prompt has already
// admitted its input and reached quiescence when this is called; never resubmit it here.
export function turnError(error, RequestError) {
  const chain = [], seen = new Set();
  for (let current = error; current && !seen.has(current); current = current.cause) {
    seen.add(current); chain.push(current);
  }
  const messages = [...new Set(chain.map(e => e.message).filter(Boolean))];
  const message = messages.join(': ') || 'DeepSeek 执行失败';
  const excluded = chain.some(e => ['AUTH', 'QUOTA', 'MISSING_CREDENTIAL', 'CONTEXT_WINDOW_EXCEEDED', 'INVALID_REQUEST'].includes(e.code));
  const transient = !excluded && chain.some(e => ['SERVER', 'RATE_LIMIT', 'STREAM_CLOSED', 'TIMEOUT'].includes(e.code));
  return new RequestError(-32603, message, transient ? { _meta: { coda: { failure: { kind: 'service_unavailable', input: 'accepted' } } } } : undefined);
}

export function authError(error, RequestError) {
  if (['AUTH', 'MISSING_CREDENTIAL'].includes(error?.code)) return new RequestError(-32000, 'DeepSeek 尚未认证：请配置运行机的 API Key。');
  return error;
}
