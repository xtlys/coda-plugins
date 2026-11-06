import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { config, id, inside, json, lock, managed, now, requireValue, save, text } from './store.mjs';

export const modes = ['ask', 'investigate', 'review', 'refine', 'kb', 'kb-refine', 'direct'];
export function route(root, latest, { intent, taskFile } = {}) {
  requireValue(typeof latest === 'string', '需要最新一条请求原文');
  const match = /^(kb\s+refine|ask|investigate|review|refine|kb)(?=\s|$)[ \t]*(?:\r?\n)?/i.exec(latest);
  let mode, request = latest, command;
  if (match) {
    mode = match[1].toLowerCase().replace(/\s+/, '-');
    request = latest.slice(match[0].length);
    if (mode === 'investigate' || mode === 'kb') {
      if (request.startsWith('# ')) command = /^# (\S+)/.exec(request)?.[1].toLowerCase();
      else {
        const word = /^(\S+)[ \t]*(?:\r?\n)?/.exec(request);
        if (word) { command = word[1].toLowerCase(); request = `# ${command[0].toUpperCase()}${command.slice(1)}\n${request.slice(word[0].length)}`; }
      }
    }
  } else {
    requireValue(['coding', 'research', 'maintenance'].includes(intent), '无显式关键词时，按 AGENTS.md 的语义判断传入 --intent coding|research|maintenance');
    mode = { coding: 'investigate', research: 'ask', maintenance: 'direct' }[intent];
    if (mode === 'investigate') { command = 'repro'; request = `# Repro\n${latest}`; }
  }
  if (taskFile !== undefined) {
    inside(root, taskFile);
    requireValue(mode === 'review' || (mode === 'investigate' && command === 'repro'), '--task-file 只用于 review 或 investigate repro');
    const body = (mode === 'review' ? request : request.replace(/^# Repro(?:\r?\n)?/i, '')).trim();
    requireValue(!body || body === `@${taskFile}` || body === `<tagging REPO-ROOT/${taskFile}>`,
      '--task-file 只能展开空正文或对应文件标签；存在附加说明时请去掉该选项，保留完整请求');
  }
  if (mode === 'investigate' && command === 'repro') {
    const body = request.replace(/^# Repro(?:\r?\n)?/i, '');
    if (taskFile || !body.trim()) {
      const path = taskFile ?? 'TODO_TASK.md';
      request = `# Repro\n${readFileSync(inside(root, path), 'utf8')}`;
    }
  }
  if (mode === 'review' && (taskFile || !request.trim())) {
    taskFile ??= 'TODO_TASK.md';
    requireValue(existsSync(inside(root, taskFile)), `任务文件不存在：${taskFile}`);
    request = `<tagging REPO-ROOT/${taskFile}>`;
  }
  return { mode, command: command ?? null, latest, request, ...(taskFile ? { taskFile } : {}) };
}
const location = (root, key) => managed(root, `requests/${id(key)}.json`);
const terminal = ['done', 'abandoned'];
function requireActive(root, r, runId) {
  text(runId, 'runId', 200);
  requireValue(r.status === 'running' && r.runId === runId && json(managed(root, 'active-request.json')).id === r.id,
    '请求已结束或不属于当前运行，请勿执行旧任务');
}
function release(root, key) {
  const file = managed(root, 'active-request.json');
  if (existsSync(file) && json(file).id === key) rmSync(file);
}
export function getRequest(root, key, runId) {
  const r = json(location(root, key));
  requireValue(r.schemaVersion === 2 && r.projectId === config(root).projectId && modes.includes(r.mode), '请求版本或项目不匹配');
  requireValue(['pending', 'running', ...terminal].includes(r.status), '未知请求状态');
  if (runId !== undefined) requireActive(root, r, runId);
  return r;
}
export function startRequest(root, latest, options) {
  const routed = route(root, latest, options);
  const r = { schemaVersion: 2, id: `r-${randomUUID()}`, projectId: config(root).projectId, ...routed, status: 'pending', createdAt: now() };
  save(location(root, r.id), r); return r;
}
export function bindRequest(root, key, runId) {
  text(runId, 'runId', 200);
  return lock(root, 'request', () => {
    const r = getRequest(root, key), activeFile = managed(root, 'active-request.json');
    requireValue(!terminal.includes(r.status), '请求已结束，不能重新绑定；新工作请创建新请求');
    requireValue(!r.runId || r.runId === runId, '请求已绑定其他运行，请恢复原运行');
    if (existsSync(activeFile)) {
      const active = json(activeFile);
      if (active.id && active.id !== key) requireValue(terminal.includes(getRequest(root, active.id).status), '同一工作区的固定任务文档正在使用中，请先完成、恢复或安全放弃原请求');
    }
    r.runId = runId; r.status = 'running'; save(location(root, key), r); save(activeFile, { id: key });
    return r;
  });
}
export function finishRequest(root, key, runId) {
  return lock(root, 'request', () => {
    const r = getRequest(root, key);
    requireValue(r.runId === runId, '只能完成本运行绑定的请求');
    if (r.status !== 'done') { requireActive(root, r, runId); r.status = 'done'; r.finishedAt = now(); save(location(root, key), r); }
    release(root, key);
    return r;
  });
}
export function abandonRequest(root, key, { reason, runStatus } = {}) {
  text(reason, '放弃原因', 2000);
  return lock(root, 'request', () => {
    const r = getRequest(root, key);
    if (r.status === 'abandoned') { release(root, key); return r; }
    requireValue(r.status !== 'done', '已完成请求不能放弃');
    if (r.runId) {
      // The caller obtains a fresh workflow_status after cancellation has finished. Never infer
      // a stopped run from a task rejection, missing process, timeout, or a free-form boolean.
      requireValue(runStatus?.runId === r.runId && runStatus.workflow === 'vczh'
        && runStatus.inputs?.root === root && runStatus.inputs?.request === key, '需要原运行的 workflow_status JSON，且运行、工作区和请求须匹配');
      requireValue(['succeeded', 'failed', 'cancelled'].includes(runStatus.state) && Number.isFinite(runStatus.finishedAt),
        '原运行尚未结束；先取消并确认退出后才能放弃请求');
      requireValue((runStatus.tasks === undefined || (Array.isArray(runStatus.tasks) && runStatus.tasks.length === 0))
        && Array.isArray(runStatus.jobs) && runStatus.jobs.every(job => ['pending', 'succeeded', 'failed', 'cancelled', 'skipped'].includes(job.state)),
      '原运行仍有活动任务或步骤，不能释放固定任务文档');
    }
    r.status = 'abandoned'; r.finishedAt = now();
    r.abandonment = { reason, ...(r.runId ? { runState: runStatus.state, runFinishedAt: runStatus.finishedAt } : {}) };
    save(location(root, key), r); release(root, key);
    return r;
  });
}
