// Adapted from @coda-console/review, MIT; see NOTICE.
import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { appendGithubOutput } from './store.mjs';

const summary = text => { if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text); };
const url = process.env.URL;
const every = (Number(process.env.EVERY) || 10) * 1000;

if (!/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/.test(url ?? '')) {
  console.error(`不是 GitHub 上的 PR：${url}`);
  process.exit(1);
}

function read() {
  const done = spawnSync('gh', ['pr', 'checks', url, '--json', 'name,state,bucket,description,link'], { encoding: 'utf8' });
  try {
    const list = JSON.parse(done.stdout);
    if (Array.isArray(list)) return list;
  } catch {}
  return /no checks reported/i.test(done.stderr ?? '') ? [] : null;
}

let checks;
let unread = 0;
for (;;) {
  checks = read();
  if (checks === null) {
    if (++unread >= 5) {
      console.error('读不到 PR 的 GitHub 检查状态');
      process.exit(1);
    }
  } else {
    unread = 0;
    const pending = checks.filter(c => c.bucket === 'pending');
    if (!pending.length) break;
    console.log(`等待检查：${pending.map(c => c.name).join('、')}`);
  }
  await delay(every);
}

const VERDICT = { pass: '通过', fail: '未通过', cancel: '已取消', skipping: '跳过' };
const failed = checks.filter(c => ['fail', 'cancel'].includes(c.bucket));
const line = c => `  - ${c.name}：${VERDICT[c.bucket] ?? c.state}${c.description ? `，${c.description}` : ''}`;
const lines = checks.length ? `\n${checks.map(line).join('\n')}` : '';
appendGithubOutput({ passed: !failed.length, lines });
summary(`## GitHub 检查：${!checks.length ? '无检查项' : failed.length ? `${failed.length} 项未通过` : '全部通过'}${lines}\n`);
