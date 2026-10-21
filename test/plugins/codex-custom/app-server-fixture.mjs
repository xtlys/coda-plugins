// Log only the isolation boundary, then speak the existing fixture app-server protocol. No real credentials or service.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const env = process.env;
writeFileSync(join(env.CODEX_HOME, 'runtime.json'), JSON.stringify({
  args: process.argv.slice(2), home: env.CODEX_HOME, sqlite: env.CODEX_SQLITE_HOME, binary: env.CODEX_PATH,
  inherited: ['CODEX_CONFIG', 'MODEL_PROVIDER', 'DEFAULT_AUTH_REQUEST', 'CODA_PLUGIN_EXTENSIONS',
    'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN'].filter(key => key in env),
  providerKey: env.CUSTOM_PROVIDER_TEST_KEY,
}));
await import('../codex/app-server-fixture.mjs');
