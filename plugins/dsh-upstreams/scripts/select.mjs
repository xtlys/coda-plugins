import { choose } from './manager.mjs';
try { await choose(JSON.parse(process.env.CODA_PANEL_ARGS || '{}').upstream); }
catch (error) { console.error(error instanceof SyntaxError ? '切换参数无效' : error.message); process.exitCode = 1; }
