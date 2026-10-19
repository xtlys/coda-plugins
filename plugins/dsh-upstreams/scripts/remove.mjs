import { remove } from './manager.mjs';
try { await remove(JSON.parse(process.env.CODA_PANEL_ARGS || '{}').upstream); }
catch (error) { console.error(error instanceof SyntaxError ? '删除参数无效' : error.message); process.exitCode = 1; }
