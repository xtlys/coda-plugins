// Metadata follows https://api-docs.deepseek.com/quick_start/agent_integrations/codex/ (2026-10-21).
// Credentials are read from the environment only at configuration time, never from command-line arguments.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const deepseekModels = ['deepseek-flash', 'deepseek-v4-pro'].map((slug, index) => ({
  slug, display_name: index ? 'DeepSeek V4 Pro' : 'DeepSeek Flash', description: 'DeepSeek 官方 API', priority: index + 1,
  visibility: 'list', supported_in_api: true, minimal_client_version: '0.144.0',
  context_window: 1048576, max_context_window: 1048576, effective_context_window_percent: 95,
  default_reasoning_level: 'high', supported_reasoning_levels: ['low', 'high', 'max'].map(effort => ({ effort, description: effort })),
  supports_reasoning_summaries: true, default_reasoning_summary: 'none', reasoning_summary_format: 'experimental',
  prefer_websockets: false, support_verbosity: true, default_verbosity: 'low',
  apply_patch_tool_type: 'freeform', shell_type: 'shell_command', web_search_tool_type: 'text',
  input_modalities: index ? ['text'] : ['text', 'image'], supports_image_detail_original: !index,
  supports_parallel_tool_calls: true, truncation_policy: { mode: 'tokens', limit: 10000 },
  tool_mode: null, multi_agent_version: 'v2', use_responses_lite: false, experimental_supported_tools: [],
  include_skills_usage_instructions: false, auto_review_model_override: null, auto_compact_token_limit: null,
  availability_nux: null, upgrade: null, default_service_tier: null, supports_search_tool: !index,
  base_instructions: 'You are a coding assistant using DeepSeek. Work with the user in the shared workspace. '
    + 'Use the available tools to inspect, edit, and verify the requested work. Follow the user and developer instructions. '
    + 'Keep credentials private. Answer in the user\'s language, report what was tested, and state material limitations.',
}));

export function configureDeepSeek({ key = process.env.DEEPSEEK_API_KEY, userHome = homedir() } = {}) {
  if (typeof key !== 'string' || !key.trim() || /[\r\n]/.test(key)) throw new Error('需要非空的 DEEPSEEK_API_KEY 环境变量');
  const customHome = join(userHome, '.codex-custom'), config = join(customHome, 'config.toml'), catalog = join(customHome, 'models.json');
  if (existsSync(config) || existsSync(catalog)) throw new Error('Custom 配置或模型目录已存在，已保留；请在独立目录中编辑');
  mkdirSync(customHome, { recursive: true, mode: 0o700 });
  const toml = `model = "deepseek-flash"\nmodel_provider = "deepseek"\nmodel_reasoning_effort = "high"\n`
    + 'forced_login_method = "api"\ncli_auth_credentials_store = "file"\nweb_search = "disabled"\ncheck_for_update_on_startup = false\n'
    + `model_catalog_json = ${JSON.stringify(catalog)}\n\n[model_providers.deepseek]\nname = "DeepSeek"\n`
    + 'base_url = "https://api.deepseek.com"\nwire_api = "responses"\nrequires_openai_auth = false\nsupports_websockets = false\n'
    + `experimental_bearer_token = ${JSON.stringify(key.trim())}\n`;
  writeFileSync(catalog, JSON.stringify({ models: deepseekModels }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  writeFileSync(config, toml, { mode: 0o600, flag: 'wx' });
  return { config, catalog };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const { config } = configureDeepSeek(); console.log(`DeepSeek 配置已写入 ${config}（0600）`); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
