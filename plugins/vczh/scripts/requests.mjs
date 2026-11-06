import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
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
  if (mode === 'investigate' && command === 'repro') {
    const body = request.replace(/^# Repro(?:\r?\n)?/i, '');
    // taskFile is supplied only when the remaining message consists solely of a file tag.
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
export function getRequest(root, key) {
  const r = json(location(root, key));
  requireValue(r.schemaVersion === 2 && r.projectId === config(root).projectId && modes.includes(r.mode), '请求版本或项目不匹配');
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
    requireValue(!r.runId || r.runId === runId, '请求已绑定其他运行，请恢复原运行');
    if (existsSync(activeFile)) {
      const active = json(activeFile);
      if (active.id && active.id !== key) requireValue(getRequest(root, active.id).status === 'done', '同一工作区的固定任务文档正在使用中，请先完成或恢复原运行');
    }
    if (r.status !== 'done') { r.runId = runId; r.status = 'running'; save(location(root, key), r); save(activeFile, { id: key }); }
    return r;
  });
}
export function finishRequest(root, key, runId) {
  return lock(root, 'request', () => {
    const r = getRequest(root, key);
    requireValue(r.runId === runId, '只能完成本运行绑定的请求');
    if (r.status !== 'done') { r.status = 'done'; r.finishedAt = now(); save(location(root, key), r); }
    return r;
  });
}
