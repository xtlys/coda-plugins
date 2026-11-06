import { appendFileSync } from 'node:fs';
import { bindRequest, finishRequest, requestGroup } from './requests.mjs';
import { register, repo, requireValue } from './store.mjs';

try {
  const root = repo(process.env.VCZH_ROOT);
  requireValue(root === process.env.VCZH_ROOT, 'root 必须是 vczh init 返回的真实仓库根目录');
  const action = process.argv[2]; requireValue(['workspace', 'route', 'finish'].includes(action), '未知工作流动作');
  const group = requestGroup(root);
  let output;
  if (action === 'workspace') output = { group };
  else {
    requireValue(process.env.VCZH_GROUP === group, '工作流必须先取得本项目的宿主独占组');
    const request = action === 'route'
      ? bindRequest(root, process.env.VCZH_REQUEST, process.env.VCZH_RUN)
      : finishRequest(root, process.env.VCZH_REQUEST, process.env.VCZH_RUN);
    output = { mode: request.mode, status: request.status };
  }
  register(root);
  appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(output).map(([key, value]) => `${key}=${value}\n`).join(''));
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `vczh ${action}: ${JSON.stringify(output)}\n`);
} catch (error) { console.error(`vczh: ${error.message}`); process.exitCode = 1; }
