// A separate agent identity and executable, sharing the Codex plugin's ACP/Coda adaptation through a declared dependency.
// Set the custom runtime's environment before importing that entry: its explicit CODEX_PATH bypasses the account bridge
// and bundled official CLI, including after an app-server restart.
import { mkdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { configureEnvironment } from './runtime.mjs';

const env = process.env;
const codex = JSON.parse(env.CODA_PLUGIN_DEPENDENCIES || '{}').codex;
if (typeof codex !== 'string' || !isAbsolute(codex)) throw new Error('codex-custom 需要 codex 插件提供协议适配，请在 Coda 中重新安装 codex-custom。');

configureEnvironment(env);
mkdirSync(env.CODEX_HOME, { recursive: true, mode: 0o700 });

const entry = pathToFileURL(join(codex, 'agent/entry.mjs'));
await import(entry.href);
