// Exact anchors deliberately fail closed on an upstream change. Never edit node_modules:
// the Coda plugin version pins both the harness and these small integration seams.
export function patchedAcp(source) {
  const replace = (before, after) => {
    if (source.split(before).length !== 2) throw new Error(`dsh ACP 0.2.1-rc.2 的接入点已变化：${before.slice(0, 75)}`);
    source = source.replace(before, after);
  };
  const start = source.indexOf('\tctx.on("approval/request",');
  const end = source.indexOf('\n\tconst implementation = {', start);
  if (start < 0 || end < 0) throw new Error('dsh ACP 的审批接入点已变化');
  source = source.slice(0, start) + source.slice(end);
  replace('const stream = config.stream ?? ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));',
    'coda.install({ ctx, sessions, implementation, RequestError, createUserMessage, assistantUpdates, toolCallUpdate, toolResultUpdate });\n\tconst stream = config.stream ?? ndJsonStream(coda.stream.writable, coda.stream.readable);');
  replace('inflight.agentError = new Error(errorChain(error));', 'inflight.agentError = error;');
  replace('internalError$1(`turn failed: ${inflight.agentError.message}`)', 'coda.turnError(inflight.agentError, RequestError)');
  replace('internalError$1(`turn failed: ${end.error.message}`)', 'coda.turnError(end.error, RequestError)');
  replace('const children = await Promise.race([subagents?.waitForChildren(this.agent), cancelled]);',
    'const children = coda.waitsEnabled() ? false : await Promise.race([subagents?.waitForChildren(this.agent), cancelled]);');
  return `import * as coda from ${JSON.stringify(new URL('./runtime.mjs', import.meta.url).href)};\n${source}`;
}
