// Copilot's native ACP, with its task_complete replies normalized by this plugin's relay. The CLI stays in Coda's
// process group; its exit and errors remain exits and errors, and its output is drained before this entry ends.
import { spawn } from 'node:child_process';
import { copilotBinary } from '../scripts/account.mjs';
import { readLines } from './lines.mjs';
import { CopilotRelay } from './relay.mjs';

const cli = spawn(copilotBinary() ?? 'copilot', ['--acp', '--stdio'], { stdio: ['pipe', 'pipe', 'inherit'] });
cli.stdin.on('error', () => {});
const parse = line => { try { const value = JSON.parse(line); return value && typeof value === 'object' && !Array.isArray(value) ? value : null; } catch { return null; } };
const relay = new CopilotRelay({ say: message => process.stdout.write(`${JSON.stringify(message)}\n`),
  tell: message => cli.stdin.write(`${JSON.stringify(message)}\n`) });
readLines(process.stdin).on('line', line => { const message = parse(line); if (message) relay.fromCoda(message); }).on('close', () => cli.stdin.end());
readLines(cli.stdout).on('line', line => { const message = parse(line); if (message) relay.fromAgent(message); });
let ended = false;
const end = code => { if (ended) return; ended = true; relay.close(); process.stdout.write('', () => process.exit(code)); };
cli.on('close', code => end(code ?? 1));
cli.on('error', () => end(1));
