import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { agentFailure, callCodaAgent } from './agent.mjs';
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
      `L3 Code Verifier：${checks.length ? `${checks.length - failedVerifier.length}/${checks.length} 通过` : '无代码验证脚本'}`,
      ...lintOutcome.results.filter(r => !r.passed).map(r => `  - [Lint 失败] ${r.path}：${r.output}`),
      ...failedVerifier.map(c => `  - [验证失败] ${c.id}：${c.output}`),
    ].join('\n'),
  };
}

export function extractJsonBlock(text) {
  text = String(text ?? '');
  const markerSource = String.raw`(?:(?://|#)\s*)?(?:VERDICT|DECISION|DIAGNOSIS)_JSON\s*[:=]?\s*`;
  const markerLine = new RegExp(`^${markerSource}$`);
  const leadingLines = new RegExp(String.raw`^(?:\s*(?://[^\r\n]*(?:\r?\n|$)|${markerSource}(?:\r?\n|$)|${markerSource}(?=[{\[])))*`);
  const bareMarker = /^(?:(?:\/\/|#)\s*)?(?:VERDICT|DECISION|DIAGNOSIS)_JSON\s*[:=]\s*$/;
  const fenceRanges = [];
  let opening = null;
  for (const line of text.matchAll(/[^\n]*(?:\n|$)/g)) {
    const match = line[0].trim().match(/^(`{3,}|~{3,})([^\s`~]*)\s*$/);
    if (!opening) {
      if (!match) continue;
      const previousLine = text.slice(0, line.index).trimEnd().split('\n').at(-1)?.trim();
      opening = {
        fence: match[1], start: line.index, bodyStart: line.index + line[0].length,
        json: /^(?:jsonc?)?$/i.test(match[2]), quoted: false, escaped: false,
        marked: markerLine.test(previousLine),
      };
      continue;
    }
    if (match && !match[2] && match[1][0] === opening.fence[0] && match[1].length >= opening.fence.length
      && (!opening.json || !opening.quoted)) {
      fenceRanges.push({ ...opening, bodyEnd: line.index, end: line.index + line[0].length });
      opening = null;
    } else if (opening.json) {
      // Only JSON strings can hide a closing fence; shell quoting must not affect pairing.
      if (!opening.quoted && line[0].trimStart().startsWith('//')) continue;
      for (const char of line[0]) {
        if (opening.quoted) {
          if (opening.escaped) opening.escaped = false;
          else if (char === '\\') opening.escaped = true;
          else if (char === '"') opening.quoted = false;
        } else if (char === '"') opening.quoted = true;
      }
    }
  }
  if (opening) fenceRanges.push({ ...opening, end: text.length });
  let fenced = null;
  const marked = [];
  for (const range of fenceRanges) {
    const body = text.slice(range.bodyStart, range.bodyEnd ?? range.end);
    const prefix = body.match(leadingLines)[0];
    const explicit = range.marked || prefix.trim().split('\n').some(line => markerLine.test(line.trim()));
    const candidate = { start: range.start, value: null };
    if (explicit) marked.push(candidate);
    if ((!range.json && !explicit) || range.bodyEnd === undefined) continue;
    try {
      candidate.value = JSON.parse(body.slice(prefix.length));
      if (range.json) fenced = candidate.value;
    } catch {}
  }
  const candidates = [];
  for (let start = 0; start < text.length; start++) {
    const range = fenceRanges.find(range => range.start <= start && start < range.end);
    if (range) { start = range.end - 1; continue; }
    if (text[start] !== '{' && text[start] !== '[') continue;
    const prefix = text.slice(0, start).trimEnd().split('\n').at(-1)?.trim();
    const explicit = bareMarker.test(prefix);
    const candidate = { start, value: null };
    if (explicit) marked.push(candidate);
    const stack = [];
    let quoted = false;
    let escaped = false;
    for (let end = start; end < text.length; end++) {
      const char = text[end];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') quoted = false;
        continue;
      }
      if (char === '"') quoted = true;
      else if (char === '{' || char === '[') stack.push(char);
      else if (char === '}' || char === ']') {
        if (stack.pop() !== (char === '}' ? '{' : '[')) break;
        if (!stack.length) {
          try {
            candidate.value = JSON.parse(text.slice(start, end + 1));
            candidates.push(candidate);
          } catch {}
          start = end;
          break;
        }
      }
    }
  }

  if (marked.length) return marked.sort((a, b) => a.start - b.start).at(-1).value;
  return fenced ?? candidates.filter(candidate => !Array.isArray(candidate.value)).at(-1)?.value ?? null;
}

export function parseVerifierAnswer(answer) {
  try {
    const verdict = extractJsonBlock(answer);
    requireValue(verdict && typeof verdict.passed === 'boolean', 'Verifier未输出含布尔值 passed 的结构化 JSON 结论');
    const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
    if ('findings' in verdict) {
      requireValue(Array.isArray(verdict.findings) && verdict.findings.every(isObject), 'Verifier findings 须为数组且每项须为非 null 普通对象');
    }
    if ('evidence' in verdict) {
      requireValue(Array.isArray(verdict.evidence) && verdict.evidence.every(item => typeof item === 'string' || isObject(item)), 'Verifier evidence 须为数组且每项须为文本或非 null 普通对象');
    }
    if ('summary' in verdict) requireValue(typeof verdict.summary === 'string', 'Verifier summary 须为文本');
    return { verdict };
  } catch (error) {
    return { error: error.message, failureKind: 'invalid_output' };
  }
}

function skippedAgent(summary = 'L3 Agent/UI Verifier：当前 .dickda/verifiers/ 无 Agent/UI 规约文件，跳过。') {
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
    `## 输出契约\n完成真实运行与截图/日志取证后，在最后一条回复末尾附上 \`\`\`json 块。通过时 summary 须说明实测结果，evidence 至少列出一项本次运行的截图、日志或命令输出。findings 每项含 level（"must" 或 "nit"）、title 和 detail。\n\`\`\`json\n{"passed": true, "summary": "登录后显示首页", "evidence": [{"path": "artifacts/login.png", "detail": "首页显示当前用户名"}], "findings": []}\n\`\`\``,
  ].join('\n\n');

  writeFileSync(promptFile, prompt);
  try {
    const args = [
      ...(commit ? ['--commit', commit] : []),
      '--title', `dickda Mode · 实证验收（${resolved.tier}）`,
      ...agentArgs(resolved.agent),
      '--json',
      '--prompt-file', promptFile,
    ];
    const res = callCodaAgent(args, root, runner);
    const failure = (reason, failureKind = res.failureKind || 'invalid_output') => {
      const diagnostics = { exitCode: res.status, signal: res.signal, session: res.session, failureKind };
      const summary = `L3 Agent/UI Track：${reason}\n${agentFailure({ ...res, failureKind })}`;
      return {
        passed: false, skipped: false, tier: resolved.tier, escalated: resolved.escalated,
        agent: resolved.summary, ...diagnostics, summary, evidence: [],
        findings: [{ level: 'must', title: reason, ...diagnostics, detail: summary }],
      };
    };
    if (res.status !== 0 || !res.parsed) return failure('coda-agent 验证会话异常退出');
    const payload = res.parsed;
    const { verdict, error } = parseVerifierAnswer(payload.answer ?? '');
    if (error) return failure(error, 'invalid_output');
    const findings = Array.isArray(verdict.findings) ? verdict.findings : [];
    const hasMust = findings.some(f => f.level === 'must');
    const passed = verdict.passed === true && !hasMust;
    if (passed) {
      const hasText = value => typeof value === 'string' && value.trim().length > 0;
      if (!hasText(verdict.summary)) return failure('Agent/UI 验收通过时 summary 须为非空文本');
      const hasEvidence = item => hasText(item) || (item && typeof item === 'object'
        && !Array.isArray(item) && Object.values(item).some(hasText));
      if (!Array.isArray(verdict.evidence) || !verdict.evidence.some(hasEvidence)) return failure('Agent/UI 验收通过时 evidence 须至少包含一项非空实证证据');
    }
    return {
      passed,
      skipped: false,
      tier: resolved.tier,
      escalated: resolved.escalated,
      agent: resolved.summary,
      session: res.session ?? null,
      ...(!passed ? { exitCode: res.status ?? 0, signal: res.signal ?? null, failureKind: 'gate_rejected' } : {}),
      summary: `L3 Agent/UI Track（${resolved.summary}）：${passed ? '通过' : '未通过'} — ${verdict.summary ?? ''}`,
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
        result = process.env.UI === 'false' ? skippedAgent('L3 Agent/UI Track已按参数跳过。') : runAgentVerifiers(root, {
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
      requireValue(codeRes && typeof codeRes.passed === 'boolean' && codeRes.commit, '缺少Code Track 结果或提交 SHA');
      const agentRes = artifacts && existsSync(join(artifacts, 'agent-verify.json'))
        ? JSON.parse(readFileSync(join(artifacts, 'agent-verify.json'), 'utf8'))
        : { passed: true, skipped: true, commit: codeRes.commit, summary: 'L3 Agent/UI Track未启用。', evidence: [], findings: [] };
      requireValue(agentRes.commit === codeRes.commit, `Dual-Track Verification提交不一致：Code Track ${codeRes.commit} vs Agent/UI Track ${agentRes.commit}`);
      const passed = Boolean(codeRes.passed && agentRes.passed);
      const agentDiagnostics = !agentRes.passed ? [
        `Agent/UI Track：failureKind=${agentRes.failureKind}, exitCode=${agentRes.exitCode}`,
        agentRes.signal ? `signal=${agentRes.signal}` : '',
        agentRes.session ? `session=${agentRes.session}` : '',
      ].filter(Boolean).join(', ') : '';
      const report = [`验证提交：\`${codeRes.commit}\``, codeRes.summary, [agentRes.summary, agentDiagnostics].filter(Boolean).join('\n')].filter(Boolean).join('\n\n');
      appendGithubOutput({
        commit: codeRes.commit,
        passed,
        report,
        evidence: JSON.stringify(agentRes.evidence ?? []),
        findings: JSON.stringify(agentRes.findings ?? []),
      });
      if (process.env.GITHUB_STEP_SUMMARY) {
        writeFileSync(process.env.GITHUB_STEP_SUMMARY, `## dickda Mode · Dual-Track Verification（${codeRes.commit.slice(0, 12)}）：${passed ? '通过' : '未通过'}\n\n${report}\n`, { flag: 'a' });
      }
    } else {
      throw new Error(`未知 verify 动作：${action}`);
    }
  } catch (error) {
    console.error(`dickda verify: ${error.message}`);
    process.exitCode = 1;
  }
}
