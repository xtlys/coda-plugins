// Execute the plugin's actual pinned Codex 0.162.1 against a loopback-only Responses/MCP server. Inspect the model
// request, not just an adapter setting: native delegation tools must disappear, Coda tools remain, and off restores them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentProcess } from '../../../check/process.mjs';
import { cleared, clientCapabilities } from '../../../check/coda.mjs';
import { pluginDir } from '../plugin.mjs';

const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const active = (role = 'parent', instructions = 'CODA_ULTRA_PARENT_POLICY: Delegate independent tasks through Coda spawn and send.') => ({ version: 1, active: true,
  role, instructions, childInstructions: 'CODA_ULTRA_CHILD_POLICY: Finish the Coda task yourself. Never delegate.',
  policies: [{ id: 'ultra', plugin: 'ultra', version: '1' }] });
const off = { version: 1, active: false };

test('pinned native Codex switches parent on/off, suppresses child tools, and keeps the same thread/history', { timeout: 45000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'coda-codex-native-policy-'));
  mkdirSync(join(root, 'home'));
  let proc;
  const requests = [], mcpCalls = [], probed = new Set();
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    if (req.url === '/mcp') {
      if (req.method === 'GET') { res.writeHead(405).end(); return; }
      const message = JSON.parse(raw || '{}');
      if (message.method === 'tools/call') mcpCalls.push(message.params.name);
      if (message.id === undefined) { res.writeHead(202).end(); return; }
      const result = message.method === 'initialize' ? { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'coda', version: '1' } }
        : message.method === 'tools/list' ? { tools: ['spawn', 'send'].map(name => ({ name, description: `Coda ${name}`,
          inputSchema: { type: 'object', properties: {}, additionalProperties: true } })) }
        : { content: [{ type: 'text', text: 'ok' }] };
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result })); return;
    }
    if (req.url !== '/responses') { res.writeHead(404).end(); return; }
    const body = JSON.parse(raw);
    requests.push(body);
    const id = `local-response-${requests.length}`;
    const title = body.text?.format?.type === 'json_schema';
    const marker = body.input.filter(item => item.role === 'user').at(-1)?.content?.map(item => item.text ?? '').join('');
    const probe = marker === 'CODA_NATIVE_ON_SECOND' && !probed.has(marker);
    if (probe) probed.add(marker);
    const events = [
      { type: 'response.created', response: { id } },
      { type: 'response.output_item.done', item: probe ? { type: 'custom_tool_call', namespace: 'functions', name: 'exec', call_id: 'coda-tools-proof',
        input: 'text({codaTools:ALL_TOOLS.filter(t=>t.name.includes("coda")).map(t=>t.name),nativeTools:ALL_TOOLS.filter(t=>/(spawn_agent|followup_task|send_message|wait_agent|list_agents|interrupt_agent)/.test(t.name)).map(t=>t.name)}); const spawn=ALL_TOOLS.find(t=>t.name.includes("coda")&&t.name.endsWith("spawn")); if(spawn)text(await tools[spawn.name]({}));' }
        : { type: 'message', role: 'assistant', id: `message-${requests.length}`,
          content: [{ type: 'output_text', text: title ? '{"title":"Local test"}' : 'Local response complete.' }] } },
      { type: 'response.completed', response: { id, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
    ];
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    res.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
  });
  server.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { if (proc) { await proc.terminate(1000); proc.kill(); } server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); rmSync(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const config = { model: 'gpt-6.1-sol', model_provider: 'coda-test', model_reasoning_effort: 'high',
    features: { multi_agent: true, multi_agent_v2: { enabled: true, non_code_mode_only: true }, shell_snapshot: false, fast_mode: true },
    model_providers: { 'coda-test': { name: 'Coda local test', base_url: base, wire_api: 'responses', requires_openai_auth: false,
      request_max_retries: 0, stream_max_retries: 0, supports_websockets: false } } };
  // The advisory title thread uses native startup config rather than the main thread's ACP overrides. Route that
  // thread to loopback too, and keep any test credentials in this temporary directory.
  writeFileSync(join(root, 'home/config.toml'), `model = "gpt-6.1-sol"\nmodel_provider = "coda-test"\nmodel_reasoning_effort = "high"\ncli_auth_credentials_store = "file"\ndeveloper_instructions = "CODA_STATIC_BASELINE: preserve my project instructions."\n[features]\nmulti_agent = true\nshell_snapshot = false\nfast_mode = true\n[features.multi_agent_v2]\nenabled = true\nnon_code_mode_only = true\n[model_providers.coda-test]\nname = "Coda local test"\nbase_url = ${JSON.stringify(base)}\nwire_api = "responses"\nrequires_openai_auth = false\nrequest_max_retries = 0\nstream_max_retries = 0\nsupports_websockets = false\n`);
  proc = new AgentProcess({ command: `exec ${quote(process.execPath)} ${quote(join(pluginDir('codex'), 'agent/entry.mjs'))}`, cwd: root, onMessage: message => {
    if (message.method === 'session/request_permission') proc.respond(message.id, { outcome: { outcome: 'selected', optionId: 'allow_once' } });
  },
    env: { ...cleared(process.env), CODEX_HOME: join(root, 'home'), CODEX_CONFIG: JSON.stringify(config),
      CODEX_PATH: join(pluginDir('codex'), 'node_modules/@openai/codex/bin/codex.js'), MODEL_PROVIDER: 'coda-test',
      CODEX_API_KEY: 'local-test-only', OPENAI_API_KEY: 'local-test-only', OPENAI_BASE_URL: base } });
  const request = async (method, params) => {
    const answer = await proc.request(method, params, { timeout: 15000 });
    assert.equal(answer.error, undefined, `${JSON.stringify(answer.error)}\n${proc.stderr}`); return answer.result;
  };
  const init = await request('initialize', { protocolVersion: 1, clientCapabilities: clientCapabilities() });
  assert.deepEqual(init.agentCapabilities._meta.coda.delegation, { version: 1, perTurn: true, disableNative: true, actualExecution: true });
  const opened = await request('session/new', { cwd: root, mcpServers: [{ type: 'http', name: 'coda', url: `${base}/mcp`, headers: [] }],
    systemPrompt: { mode: 'append', content: [{ type: 'text', text: 'CODA_CLIENT_BASELINE: preserve my client instructions.' }] } });
  const sessionId = opened.sessionId;
  const model = opened.configOptions.find(option => option.category === 'model').currentValue;
  const effort = opened.configOptions.find(option => option.category === 'thought_level').currentValue;
  const options = Object.fromEntries(opened.configOptions.filter(option => option.category === 'model_config').map(option => [option.id, option.currentValue]));
  let execution = { agent: 'codex', model, effort, ...(Object.keys(options).length ? { options } : {}) };
  const configure = async delegation => {
    const result = await request('_coda/delegation/configure', { sessionId, delegation, execution });
    assert.deepEqual(result.execution, execution); return result;
  };
  const turn = async (marker, delegation) => {
    const before = requests.length;
    await request('session/prompt', { sessionId, prompt: [{ type: 'text', text: marker }], _meta: { coda: { delegation } } });
    const sent = requests.slice(before).find(body => JSON.stringify(body.input).includes(marker) && body.text?.format?.type !== 'json_schema');
    assert.ok(sent, `missing Responses request for ${marker}`); return sent;
  };
  const tools = body => body.tools ?? body.input.filter(item => item.type === 'additional_tools').flatMap(item => item.tools);
  const nativeTools = body => JSON.stringify(tools(body)).includes('spawn_agent');
  const allText = body => JSON.stringify(body.input);
  const policyMessages = body => body.input.filter(item => item.role === 'developer' && item.type === 'message')
    .map(item => item.content.map(block => block.text ?? '').join('')).filter(value => value.startsWith('<coda/delegation>'));
  const original = await turn('CODA_NATIVE_OFF_FIRST', off);
  assert.equal(nativeTools(original), true);
  assert.equal(policyMessages(original).length, 0, 'never-enabled sessions keep their native guidance');
  await configure(active());
  const enabled = await turn('CODA_NATIVE_ON_SECOND', active());
  assert.equal(nativeTools(enabled), false);
  assert.match(policyMessages(enabled).at(-1), /CODA_ULTRA_PARENT_POLICY/);
  assert.deepEqual(mcpCalls, ['spawn'], 'Coda delegation tools remain callable through native code mode');
  const proof = requests.flatMap(body => body.input).find(item => item.type === 'custom_tool_call_output' && item.call_id === 'coda-tools-proof');
  assert.ok(proof?.output.some(block => block.text?.includes('"nativeTools":[]')));
  assert.match(allText(enabled), /CODA_NATIVE_OFF_FIRST/, 'the original user history survives native cold resume');
  const child = active('child', 'CODA_ULTRA_CHILD_POLICY: Finish the assigned Coda task yourself. Never delegate.');
  await request('session/set_config_option', { sessionId, configId: 'reasoning_effort', value: 'medium' });
  await request('session/set_config_option', { sessionId, configId: 'service-tier', value: 'priority' });
  await request('session/set_config_option', { sessionId, configId: 'collaboration_mode', value: 'plan' });
  execution = { ...execution, effort: 'medium', options: { 'service-tier': 'priority' } };
  await configure(child);
  const delegated = await turn('CODA_NATIVE_CHILD_THIRD', child);
  assert.equal(nativeTools(delegated), false);
  assert.match(policyMessages(delegated).at(-1), /CODA_ULTRA_CHILD_POLICY/);
  assert.doesNotMatch(policyMessages(delegated).at(-1), /CODA_ULTRA_PARENT_POLICY/);
  assert.equal(delegated.reasoning.effort, 'medium');
  assert.equal(delegated.service_tier, 'priority');
  assert.match(allText(delegated), /Plan Mode|Plan mode/, 'application policy preserves native plan guidance');
  await configure(off);
  const disabled = await turn('CODA_NATIVE_OFF_FOURTH', off);
  assert.equal(nativeTools(disabled), true);
  assert.match(policyMessages(disabled).at(-1), /policy is now disabled/);
  assert.doesNotMatch(policyMessages(disabled).at(-1), /CODA_ULTRA_(?:PARENT|CHILD)_POLICY/);
  assert.match(allText(disabled), /CODA_NATIVE_OFF_FIRST/);
  assert.match(allText(disabled), /CODA_NATIVE_CHILD_THIRD/);
  assert.equal(disabled.model, model);
  assert.equal(disabled.reasoning?.effort, 'medium');
  assert.equal(disabled.service_tier, 'priority');
  for (const body of [enabled, delegated, disabled]) {
    assert.match(allText(body), /CODA_STATIC_BASELINE/);
    assert.match(allText(body), /CODA_CLIENT_BASELINE/);
  }
  // Restoring with inactive metadata revokes a policy that may still be present in durable native history.
  await request('session/load', { sessionId, cwd: root, mcpServers: [], _meta: { coda: { delegation: off } } });
  const restored = await turn('CODA_NATIVE_RESTORED_FIFTH', off);
  assert.equal(nativeTools(restored), true);
  assert.match(policyMessages(restored).at(-1), /policy is now disabled/);
  assert.match(allText(restored), /CODA_NATIVE_OFF_FIRST/);
  for (const body of [enabled, delegated, disabled, restored]) assert.equal(body.prompt_cache_key, original.prompt_cache_key, 'native thread identity stays stable');

  // A child opened with policy already active is gated and confirmed before its very first input. Its advisory title
  // thread must also hide native delegation tools, rather than offering an uncounted auxiliary escape.
  const beforeChild = requests.length;
  const fresh = await request('session/new', { cwd: root, mcpServers: [], _meta: { coda: { delegation: child } } });
  const childModel = fresh.configOptions.find(option => option.category === 'model').currentValue;
  const childEffort = fresh.configOptions.find(option => option.category === 'thought_level').currentValue;
  const childOptions = Object.fromEntries(fresh.configOptions.filter(option => option.category === 'model_config').map(option => [option.id, option.currentValue]));
  const childExecution = { agent: 'codex', model: childModel, effort: childEffort, ...(Object.keys(childOptions).length ? { options: childOptions } : {}) };
  assert.deepEqual((await request('_coda/delegation/configure', { sessionId: fresh.sessionId, delegation: child, execution: childExecution })).execution, childExecution);
  assert.equal(requests.length, beforeChild, 'native confirmation starts no model call');
  await request('session/prompt', { sessionId: fresh.sessionId, prompt: [{ type: 'text', text: 'CODA_NATIVE_FRESH_CHILD' }], _meta: { coda: { delegation: child } } });
  const childRequests = requests.slice(beforeChild);
  assert.ok(childRequests.length >= 2, 'main task and advisory title were both exercised');
  for (const body of childRequests) assert.equal(nativeTools(body), false);
  const childTask = childRequests.find(body => body.text?.format?.type !== 'json_schema');
  assert.match(policyMessages(childTask).at(-1), /CODA_ULTRA_CHILD_POLICY/);
  assert.doesNotMatch(allText(childTask), /<multi_agent_role>|<multi_agent_mode>/, 'fresh children have no opposing native guidance');
});
