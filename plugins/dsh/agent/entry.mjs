import { createRequire, registerHooks } from 'node:module';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { patchedAcp } from './patch.mjs';
import { close, receive, send, isBound } from './transport.mjs';
import { patchedUpstream, closeUpstreamSource } from './upstreams.mjs';

// Resolve all implementation seams through the declared, locked harness dependency.
const cli = import.meta.resolve('@deepseek-ai/dsh/lib/bin.js');
const require = createRequire(cli);
const acp = pathToFileURL(require.resolve('@deepseek-ai/dsh-acp')).href;
const provider = pathToFileURL(require.resolve('@deepseek-ai/dsh-llm-deepseek-api-key')).href;
registerHooks({ load(url, context, next) {
  const loaded = next(url, context);
  if (url === acp) return { ...loaded, source: patchedAcp(Buffer.from(loaded.source).toString('utf8')) };
  if (url === provider) return { ...loaded, source: patchedUpstream(Buffer.from(loaded.source).toString('utf8')) };
  return loaded;
} });
process.once('SIGTERM', closeUpstreamSource);
process.once('SIGINT', closeUpstreamSource);
createInterface({ input: process.stdin }).on('line', line => {
  let message;
  try { message = JSON.parse(line); }
  catch { send({ id: null, error: { code: -32700, message: 'Invalid JSON' } }); return; }
  receive(message);
}).on('close', () => { closeUpstreamSource(); close(); });
process.argv = [process.execPath, fileURLToPath(cli), '--profile', 'acp', '--patch', fileURLToPath(new URL('./coda.patch.yml', import.meta.url))];
await (await import(cli)).runCli();
if (!isBound()) throw new Error('DSH profile 没有加载锁定的 Coda ACP 入口，请检查运行机的 profile 覆盖配置。');
