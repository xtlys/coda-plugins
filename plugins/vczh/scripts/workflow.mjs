import { appendFileSync } from 'node:fs';
import { bindRequest, finishRequest } from './requests.mjs';
import { register, repo, requireValue } from './store.mjs';

try {
  const root = repo(process.env.VCZH_ROOT);
  requireValue(root === process.env.VCZH_ROOT, 'root 必须是 vczh init 返回的真实仓库根目录');
  const action = process.argv[2]; requireValue(['route', 'finish'].includes(action), '未知工作流动作');
  const request = action === 'route'
    ? bindRequest(root, process.env.VCZH_REQUEST, process.env.VCZH_RUN)
    : finishRequest(root, process.env.VCZH_REQUEST, process.env.VCZH_RUN);
  register(root);
  appendFileSync(process.env.GITHUB_OUTPUT, `mode=${request.mode}\nstatus=${request.status}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `vczh ${request.mode}: ${request.status}\n`);
} catch (error) { console.error(`vczh: ${error.message}`); process.exitCode = 1; }
