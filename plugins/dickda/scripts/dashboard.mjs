import { existsSync, readFileSync } from 'node:fs';
import { assetsByKind, backups, layerHealth } from './assets.mjs';
import { prompts } from './prompts.mjs';
import { listRoles, loadSettings } from './roles.mjs';
import { atomic, config, managed } from './store.mjs';

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

export function buildDashboardData(root, settings = loadSettings()) {
  const cfg = config(root);
  const health = layerHealth(root);
  const roles = listRoles(settings);
  const plan = existsSync(managed(root, 'tasks/PLAN_5L.md')) ? readFileSync(managed(root, 'tasks/PLAN_5L.md'), 'utf8') : '';
  const todo = existsSync(managed(root, 'tasks/TODO_TASK.md')) ? readFileSync(managed(root, 'tasks/TODO_TASK.md'), 'utf8') : '';
  return {
    project: { name: cfg.name, root, projectId: cfg.projectId },
    health,
    roles,
    todo: todo.slice(0, 4000),
    plan: plan.slice(0, 6000),
    lints: assetsByKind(root, 'lints').map(({ title, path, summary }) => ({ title, path, summary })),
    verifiers: assetsByKind(root, 'verifiers').map(({ title, path, track, summary }) => ({ title, path, track, summary })),
    knowledge: assetsByKind(root, 'knowledge').map(({ title, path, summary }) => ({ title, path, summary })),
    archives: backups(root, 20),
    prompts: prompts(root).map(({ id, title, origin, enabled }) => ({ id, title, origin, enabled })),
  };
}

// Self-contained, mobile-first (360pt) responsive HTML console with zero external API requests, ready for Coda visualize{}.
export function renderDashboardHtml(data) {
  const payload = JSON.stringify(data).replaceAll('</', '<\\/');
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(data.project.name)} · dickda Mode · Five-Layer Dashboard</title>
<style>
  :root {
    --bg: #0f172a;
    --panel: #1e293b;
    --border: #334155;
    --text: #f8fafc;
    --muted: #94a3b8;
    --accent: #38bdf8;
    --ok: #34d399;
    --warn: #fbbf24;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 14px;
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif;
    background: var(--bg);
    color: var(--text);
    line-height: 1.5;
  }
  .wrap { max-width: 820px; margin: 0 auto; display: flex; flex-direction: column; gap: 12px; }
  .header { background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 14px; }
  .header h1 { margin: 0 0 4px; font-size: 18px; }
  .sub { font-size: 12px; color: var(--muted); word-break: break-all; }
  .pyramid { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 10px 0; }
  .layer-btn {
    border: 1px solid var(--border);
    background: #172554;
    color: var(--text);
    border-radius: 8px;
    padding: 10px 12px;
    cursor: pointer;
    text-align: center;
    transition: transform 0.12s, border-color 0.12s;
  }
  .layer-btn.active { border-color: var(--accent); background: #1e3a8a; }
  .layer-btn strong { display: block; font-size: 13px; }
  .layer-btn span { font-size: 11px; color: #cbd5e1; }
  .w1 { width: 100%; }
  .w2 { width: 90%; }
  .w3 { width: 80%; }
  .w4 { width: 70%; }
  .w5 { width: 58%; }
  .card { background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 14px; }
  .card h2 { margin: 0 0 8px; font-size: 15px; color: var(--accent); }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px; }
  .stat { background: #0b1220; border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; }
  .stat .k { font-size: 11px; color: var(--muted); }
  .stat .v { font-size: 15px; font-weight: 600; margin-top: 2px; }
  .list { margin: 0; padding-left: 18px; font-size: 13px; }
  .list li { margin-bottom: 5px; }
  pre {
    margin: 8px 0 0;
    padding: 10px;
    background: #0b1220;
    border-radius: 8px;
    border: 1px solid var(--border);
    overflow-x: auto;
    white-space: pre-wrap;
    font-size: 12px;
    color: #e2e8f0;
  }
  .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
  textarea {
    width: 100%;
    min-height: 68px;
    background: #0b1220;
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 8px;
    font-size: 13px;
  }
  button.primary {
    background: var(--accent);
    color: #082f49;
    border: none;
    border-radius: 8px;
    padding: 8px 14px;
    font-weight: 600;
    cursor: pointer;
  }
  .badge { display: inline-block; padding: 1px 6px; border-radius: 999px; font-size: 11px; background: #064e3b; color: var(--ok); }
</style>
</head>
<body>
<div class="wrap">
  <div class="header">
    <h1>${escapeHtml(data.project.name)} · Five-Layer Dashboard</h1>
    <div class="sub">统一资产目录：.dickda/ ｜ 点击Inverted Pyramid任意层级切换详情</div>
    <div class="pyramid" id="pyramid">
      <button class="layer-btn w1 active" data-layer="L1"><strong>L1 · Codebase</strong><span>架构契约 / 接口骨架 / 重构方案</span></button>
      <button class="layer-btn w2" data-layer="L2"><strong>L2 · Static Analysis</strong><span>Executable Spec Lints (${data.health.l2LintCount})</span></button>
      <button class="layer-btn w3" data-layer="L3"><strong>L3 · Verification</strong><span>Code Track (${data.health.l3CodeVerifierCount}) + Agent/UI Track (${data.health.l3AgentVerifierCount})</span></button>
      <button class="layer-btn w4" data-layer="L4"><strong>L4 · Work Graph &amp; Prose</strong><span>知识 (${data.health.l4KnowledgeCount}) / Pending Archive (${data.health.pendingArchives})</span></button>
      <button class="layer-btn w5" data-layer="L5"><strong>L5 · Human Review</strong><span>三角色 · 四工种（Tier Escalation）与决策反馈</span></button>
    </div>
  </div>

  <div class="card" id="detail"></div>

  <div class="card">
    <h2>向Interactor提交决策指令</h2>
    <textarea id="note" placeholder="输入对当前Five-Layer Plan、优先级或重构落层的拍板意见…"></textarea>
    <div class="actions">
      <button class="primary" id="submitBtn">放入会话输入框</button>
      <span id="statusMsg" class="sub"></span>
    </div>
  </div>
</div>
<script>
  const DATA = ${payload};
  const saved = window.openai?.widgetState?.modelContent ?? {};
  let activeLayer = saved.layer || 'L1';
  const noteEl = document.getElementById('note');
  if (saved.note) noteEl.value = saved.note;

  function persist() {
    if (window.openai?.setWidgetState) {
      window.openai.setWidgetState({ modelContent: { layer: activeLayer, note: noteEl.value }, privateContent: {} });
    }
  }

  function renderLayer() {
    document.querySelectorAll('.layer-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.layer === activeLayer);
    });
    const box = document.getElementById('detail');
    if (activeLayer === 'L1') {
      box.innerHTML = '<h2>L1 · Codebase 与Five-Layer Plan（PLAN_5L.md）</h2>' +
        '<div class="sub">当前需求（TODO_TASK.md）与Thinker产出的架构规划</div>' +
        '<pre>' + escape(DATA.plan || DATA.todo || '尚未生成 PLAN_5L.md') + '</pre>';
    } else if (activeLayer === 'L2') {
      const items = DATA.lints.map(i => '<li><strong>' + escape(i.title) + '</strong>（' + escape(i.path) + '）：' + escape(i.summary) + '</li>').join('');
      box.innerHTML = '<h2>L2 · Static Analysis（.dickda/lints/）</h2>' +
        (items ? '<ul class="list">' + items + '</ul>' : '<div class="sub">暂无自定义 Executable Spec Lint 脚本，可由Architect生成。</div>');
    } else if (activeLayer === 'L3') {
      const items = DATA.verifiers.map(i => '<li><span class="badge">' + escape(i.track) + '</span> <strong>' + escape(i.title) + '</strong>：' + escape(i.summary) + '</li>').join('');
      box.innerHTML = '<h2>L3 · Verification（.dickda/verifiers/）</h2>' +
        (items ? '<ul class="list">' + items + '</ul>' : '<div class="sub">暂无验证器资产。</div>');
    } else if (activeLayer === 'L4') {
      const kb = DATA.knowledge.map(i => '<li><strong>' + escape(i.title) + '</strong>（' + escape(i.path) + '）</li>').join('');
      const pr = DATA.prompts.map(p => '<li>' + escape(p.title) + ' [' + (p.enabled ? '已启用' : '停用') + ']</li>').join('');
      box.innerHTML = '<h2>L4 · Work Graph & Prose</h2>' +
        '<div class="grid"><div class="stat"><div class="k">Knowledge Base</div><div class="v">' + DATA.health.l4KnowledgeCount + '</div></div>' +
        '<div class="stat"><div class="k">Learning Entries</div><div class="v">' + DATA.health.l4LearningEntries + '</div></div>' +
        '<div class="stat"><div class="k">Pending Archive</div><div class="v">' + DATA.health.pendingArchives + '</div></div></div>' +
        '<p class="sub">已登记规范：</p><ul class="list">' + pr + '</ul>' +
        (kb ? '<p class="sub">Knowledge Base：</p><ul class="list">' + kb + '</ul>' : '');
    } else {
      const roles = DATA.roles.map(r => '<li><strong>' + escape(r.title) + '</strong>：' + escape(r.display) + '</li>').join('');
      box.innerHTML = '<h2>L5 · Human Review</h2><ul class="list">' + roles + '</ul>';
    }
    persist();
  }

  function escape(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  document.getElementById('pyramid').addEventListener('click', e => {
    const btn = e.target.closest('.layer-btn');
    if (!btn) return;
    activeLayer = btn.dataset.layer;
    renderLayer();
  });
  noteEl.addEventListener('input', persist);
  document.getElementById('submitBtn').addEventListener('click', async () => {
    const status = document.getElementById('statusMsg');
    if (!window.coda?.submit) {
      status.textContent = '当前预览环境不支持直接回传，请复制文字到对话框。';
      return;
    }
    await window.coda.submit({ project: DATA.project.name, focusLayer: activeLayer, instruction: noteEl.value.trim() }, { name: 'dickda-decision' });
    status.textContent = '已生成附件放入输入框，发送即可生效。';
  });

  renderLayer();
</script>
</body>
</html>`;
}

export function writeDashboard(root, outputPath, settings = loadSettings()) {
  const data = buildDashboardData(root, settings);
  const html = renderDashboardHtml(data);
  atomic(outputPath, html);
  return { path: outputPath, bytes: Buffer.byteLength(html, 'utf8'), project: data.project.name };
}
