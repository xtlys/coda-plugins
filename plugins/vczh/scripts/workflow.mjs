import { appendFileSync } from 'node:fs';
import { advance, bind } from './tasks.mjs';
import { base, fingerprint, git, register, repo, requireValue } from './store.mjs';

try {
  const root = repo(process.env.VCZH_ROOT);
  requireValue(root === process.env.VCZH_ROOT, 'root 必须是 vczh init 返回的真实仓库根目录');
  const action = process.argv[2]; requireValue(['route', 'advance', 'archive'].includes(action), '未知工作流动作');
  const current = bind(root, process.env.VCZH_TASK, process.env.VCZH_RUN);
  const result = action === 'advance' ? advance(root, current.id, process.env.VCZH_PHASE, Number(process.env.VCZH_REVISION)) : current;
  if (action === 'archive') {
    requireValue(result.phase === 'done', '任务尚未完成');
    requireValue(result.history.findLast(h => h.phase === 'review')?.fingerprint === fingerprint(root), '归档前代码变化，请 task revise 后恢复原运行');
    if (result.delivery === 'pull-request') requireValue(!git(root, 'status', '--porcelain', '--', base), 'PR 交付前须把最终知识与任务记录一同提交并推送');
  }
  register(root);
  appendFileSync(process.env.GITHUB_OUTPUT, `phase=${result.phase}\nrevision=${result.revision}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `vczh：${result.title}\n\n阶段：${result.phase}，证据版本：${result.revision}。记录：.github/vczh/TaskLogs/${result.id}/task.json\n`);
} catch (error) { console.error(`vczh: ${error.message}`); process.exitCode = 1; }
