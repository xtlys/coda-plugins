import { accessSync, constants, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

// These belong to the official runtime or override the custom runtime's own config.toml.
export const officialVariables = ['CODEX_CONFIG', 'MODEL_PROVIDER', 'DEFAULT_AUTH_REQUEST', 'CODA_PLUGIN_EXTENSIONS', 'APP_SERVER_LOGS',
  'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'CODEX_MANAGED_PACKAGE_ROOT',
  'CODEX_MANAGED_BY_NPM', 'CODEX_MANAGED_BY_BUN', 'CODEX_MANAGED_BY_PNPM', 'CODEX_MANAGED_BY_VITE_PLUS'];

export function customBinary(env = process.env, userHome = homedir()) {
  for (const dir of [join(userHome, '.local/bin'), ...(env.PATH ?? '').split(delimiter).filter(Boolean)]) {
    const binary = join(dir, 'codex-custom');
    try { if (statSync(binary).isFile()) { accessSync(binary, constants.X_OK); return binary; } } catch {}
  }
  return null;
}

export function configureEnvironment(env = process.env, userHome = homedir()) {
  env.CODEX_PATH = customBinary(env, userHome) ?? 'codex-custom';
  env.CODEX_HOME = join(userHome, '.codex-custom');
  env.CODEX_SQLITE_HOME = env.CODEX_HOME;
  for (const key of officialVariables) delete env[key];
  return env;
}
