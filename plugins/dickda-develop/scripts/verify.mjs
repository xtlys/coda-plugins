import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assetsByKind, hasAgentVerifiers, runLints } from './assets.mjs';
import { agentArgs, effectiveSettings, loadSettings, resolveEngineer, rolePrompt } from './roles.mjs';
import { appendGithubOutput, config, git, listFiles, managed, remoteGit, repo, requireValue } from './store.mjs';

export function checkoutTargetCommit(root, { commit = '', runCommit = '', branch = '', remote = 'origin' } = {}) {
  const requested = String(commit || '').trim() || String(runCommit || '').trim();
  const branchRef = String(branch || '').trim();
  if (branchRef) {
    remoteGit(root, 'fetch', '--quiet', remote, branchRef);
  }
  if (!requested) {
    return git(root, 'rev-parse', 'HEAD');
  }
  const hasLocal = spawnSync('git', ['-C', root, 'cat-file', '-e', `${requested}^{commit}`]).status === 0;
  if (!hasLocal) {
    remoteGit(root, 'fetch', '--quiet', remote, requested);
  }
  const resolved = git(root, 'rev-parse', '--verify', `${requested}^{commit}`);
  requireValue(resolved === requested, `目标验证提交不匹配：预期 ${requested}，实际 ${resolved}`);
  git(root, 'checkout', '--detach', '--force', '--quiet', resolved);
  return resolved;
}

export function runCodeVerifiers(root) {
  const lintOutcome = runLints(root);
  const scripts = listFiles(root, 'verifiers', ['.mjs', '.js', '.sh']);
  const cfg = existsSync(managed(root, 'project.json')) ? config(root) : { verifyCommands: [] };

  const checks = [];
  for (const file of scripts) {
    const relPath = relative(root, file).split('\\').join('/');
    const isShell = file.endsWith('.sh');
    const proc = spawnSync(isShell ? 'bash' : process.execPath, [file], {
      cwd: root,
      encoding: 'utf8',
      timeout: 180000,
      env: { ...process.env, DICKDA_ROOT: root },
    });
    const out = [proc.stdout, proc.stderr].filter(Boolean).join('\n').trim();
    checks.push({
      id: relPath,
      passed: proc.status === 0 && !proc.error,
      code: proc.status ?? 1,
      output: proc.error ? proc.error.message : out.slice(-4000),
    });
  }

  for (const [index, cmd] of (cfg.verifyCommands ?? []).entries()) {
    const proc = spawnSync('bash', ['-lc', cmd], {
      cwd: root,
      encoding: 'utf8',
      timeout: 300000,
      env: { ...process.env, DICKDA_ROOT: root },
    });
    const out = [proc.stdout, proc.stderr].filter(Boolean).join('\n').trim();
    checks.push({
      id: `verifyCommand[${index}]: ${cmd}`,
      passed: proc.status === 0 && !proc.error,
      code: proc.status ?? 1,
      output: proc.error ? proc.error.message : out.slice(-4000),
    });
  }

  const failedVerifier = checks.filter(c => !c.passed);
  const passed = lintOutcome.passed && failedVerifier.length === 0;
  return {
    passed,
    lints: lintOutcome,
    verifiers: checks,
    summary: [
      `L2 Lints：${lintOutcome.total ? `${lintOutcome.total - lintOutcome.failed}/${lintOutcome.total} 通过` : '无自定义规则'}`,
      `L3 代码验证器：${checks.length ? `${checks.length - failedVerifier.length}/${checks.length} 通过` : '无代码验证脚本'}`,
      ...lintOutcome.results.filter(r => !r.passed).map(r => `  - [Lint 失败] ${r.path}：${r.output}`),
      ...failedVerifier.map(c => `  - [验证失败] ${c.id}：${c.output}`),
    ].join('\n'),
  };
}

export function extractJsonBlock(text, tag = 'VERDICT_JSON') {
  const tagged = new RegExp(`\`\`\`(?:json)?\\s*//\\s*${tag}\\s*\\n([\\s\\S]*?)\`\`\``).exec(text)
    ?? new RegExp(`${tag}\\s*[:=]?\\s*\`\`\`(?:json)?\\s*\\n([\\s\\S]*?)\`\`\``).exec(text);
  if (tagged) return JSON.parse(tagged[1].trim());
  const blocks = [...String(text ?? '').matchAll(/```json\s*\n([\s\S]*?)```/g)];
  for (let i = blocks.length - 1; i >= 0; i--) {
    try { return JSON.parse(blocks[i][1].trim()); } catch {}
  }
  return null;
}

function skippedAgent(summary = 'L3 Agent/UI 验证器：当前 .dickda/verifiers/ 无 Agent/UI 规约文件，跳过。') {
  return { passed: true, skipped: true, summary, findings: [], evidence: [] };
}

export function runAgentVerifiers(root, { tier, difficulty = 'normal', rejections = 0, commit, device = '', task = '', settings = loadSettings(), runner } = {}) {
  const specs = assetsByKind(root, 'verifiers').filter(v => v.track === 'agent');
  if (!specs.length) return skippedAgent();

  const resolved = resolveEngineer('verifier', { tier, difficulty, rejections }, settings);
  const tempDir = process.env.RUNNER_TEMP || join(root, '.dickda');
  mkdirSync(tempDir, { recursive: true });
  const promptFile = join(tempDir, 'dickda-agent-verify.tmp');

  const prompt = [
    rolePrompt('verifier'),
    `## 本次实证 / UI 验收上下文\n- 工作目录：${root}\n${commit ? `- 验证提交：${commit}\n` : ''}${device ? `- 已分配独占测试设备：${device}\n` : ''}${task ? `- 关联需求摘要：\n${task}\n` : ''}`,
    `## 待逐项执行的验证规约（共 ${specs.length} 份）`,
    ...specs.map(s => `### ${s.path}\n\n${s.body}`),
    `## 输出契约\n完成真实运行与截图/日志取证后，在最后一条回复末尾附上 \`\`\`json 块（包含 passed 布尔值、summary 字符串、evidence 数组、findings 数组，每项含 level: "must"|"nit", title, detail）：\n\`\`\`json\n{"passed": true, "summary": "全部场景实证通过", "evidence": [], "findings": []}\n\`\`\``,
  ].join('\n\n');

  writeFileSync(promptFile, prompt);
  try {
    const args = [
      ...(commit ? ['--commit', commit] : []),
      '--title', `Dickda 实证验收（${resolved.tier}）`,
      ...agentArgs(resolved.agent),
      '--json',
      '--prompt-file', promptFile,
    ];
    const exec = runner ?? (cmdArgs => spawnSync('coda-agent', cmdArgs, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }));
    const res = exec(args);
    if (res.error) throw res.error;
    requireValue(res.status === 0, `coda-agent 验证会话异常退出（退出码 ${res.status}）`);
    const payload = JSON.parse(res.stdout);
    const verdict = extractJsonBlock(payload.answer ?? '');
    requireValue(verdict && typeof verdict.passed === 'boolean', '验证工程师未返回包含 passed 布尔值的结构化 JSON 结论');
    const findings = Array.isArray(verdict.findings) ? verdict.findings : [];
    const hasMust = findings.some(f => f.level === 'must');
    const passed = verdict.passed === true && !hasMust;
    return {
      passed,
      skipped: false,
      tier: resolved.tier,
      escalated: resolved.escalated,
      agent: resolved.summary,
      session: payload.session,
      summary: `L3 Agent/UI 验证（${resolved.summary}）：${passed ? '通过' : '未通过'} — ${verdict.summary ?? ''}`,
      evidence: verdict.evidence ?? [],
      findings,
    };
  } finally {
    try { writeFileSync(promptFile, ''); } catch {}
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const action = process.argv[2];
    const artifacts = process.env.CODA_ARTIFACTS;
    if (['code', 'agent-plan', 'agent'].includes(action)) {
      const root = repo();
      const commit = checkoutTargetCommit(root, {
        commit: process.env.COMMIT,
        runCommit: process.env.RUN_COMMIT,
        branch: process.env.BRANCH,
      });
      let result;
      if (action === 'agent-plan') {
        const needed = hasAgentVerifiers(root);
        appendGithubOutput({ needed, commit });
        if (!needed) result = skippedAgent();
      } else if (action === 'code') {
        result = runCodeVerifiers(root);
      } else {
        result = process.env.UI === 'false' ? skippedAgent('L3 Agent/UI 验证已按参数跳过。') : runAgentVerifiers(root, {
          tier: process.env.TIER || undefined,
          commit,
          device: process.env.DEVICE || '',
          task: process.env.TASK || '',
          settings: effectiveSettings(),
        });
      }
      if (result) {
        const track = action === 'code' ? 'code' : 'agent';
        if (artifacts) writeFileSync(join(artifacts, `${track}-verify.json`), JSON.stringify({ ...result, commit }, null, 2));
        if (action !== 'agent-plan') appendGithubOutput({ passed: result.passed, summary: result.summary, commit });
      }
    } else if (action === 'summary') {
      const codeRes = artifacts && existsSync(join(artifacts, 'code-verify.json'))
        ? JSON.parse(readFileSync(join(artifacts, 'code-verify.json'), 'utf8'))
        : null;
      requireValue(codeRes && typeof codeRes.passed === 'boolean' && codeRes.commit, '缺少代码验证轨道结果或提交 SHA');
      const agentRes = artifacts && existsSync(join(artifacts, 'agent-verify.json'))
        ? JSON.parse(readFileSync(join(artifacts, 'agent-verify.json'), 'utf8'))
        : { passed: true, skipped: true, commit: codeRes.commit, summary: 'L3 Agent/UI 验证未启用。', evidence: [], findings: [] };
      requireValue(agentRes.commit === codeRes.commit, `双轨验证提交不一致：代码轨道 ${codeRes.commit} vs 实证轨道 ${agentRes.commit}`);
      const passed = Boolean(codeRes.passed && agentRes.passed);
      const report = [`验证提交：\`${codeRes.commit}\``, codeRes.summary, agentRes.summary].filter(Boolean).join('\n\n');
      appendGithubOutput({
        commit: codeRes.commit,
        passed,
        report,
        evidence: JSON.stringify(agentRes.evidence ?? []),
        findings: JSON.stringify(agentRes.findings ?? []),
      });
      if (process.env.GITHUB_STEP_SUMMARY) {
        writeFileSync(process.env.GITHUB_STEP_SUMMARY, `## Dickda 双轨验证（${codeRes.commit.slice(0, 12)}）：${passed ? '通过' : '未通过'}\n\n${report}\n`, { flag: 'a' });
      }
    } else {
      throw new Error(`未知 verify 动作：${action}`);
    }
  } catch (error) {
    console.error(`dickda verify: ${error.message}`);
    process.exitCode = 1;
  }
}
