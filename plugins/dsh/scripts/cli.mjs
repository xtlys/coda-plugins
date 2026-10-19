// The exact CLI bundled with this plugin, for native configuration and diagnostics.
import { fileURLToPath } from 'node:url';
const cli = import.meta.resolve('@deepseek-ai/dsh/lib/bin.js');
process.argv[1] = fileURLToPath(cli);
await (await import(cli)).runCli();
